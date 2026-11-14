// Push and pull compensation: sewing the shape that was drawn.
//
// A stitch is a thread under tension lying across fabric, and it pulls its
// two penetration points toward each other. So the fabric CONTRACTS along the
// direction the stitch runs — and because the fabric has to go somewhere, it
// bulges out at right angles to it. One distortion, two visible effects:
//
//   pull  the shape comes out small across the stitch direction
//   push  the shape comes out long at right angles to the stitch direction
//
// A satin column shows both at once. Its bars run across the column, so the
// column sews NARROWER than drawn (pull) and LONGER than drawn (push) — the
// ends creep past where the digitizer put them, which on lettering is the
// difference between an O that touches the next letter and one that does not.
// A tatami fill is the same statement rotated: it comes out small along the
// rows and long across them.
//
// Each geometry takes the correction the way it can take it exactly:
//
//   satin   pull widens the column, push trims arc length off each end
//   fill    pull grows the region all round, push insets it ONLY where the
//           outline faces across the rows
//
// That last one is why push cannot be an ordinary offset. An offset moves
// every edge by the same amount; push happens in one direction only, so the
// correction has to fade to nothing on the edges that face along the rows —
// those are being pulled, not pushed, and insetting them would undo the pull
// compensation that was just applied.
//
// A UNITS TRAP, inherited and preserved rather than introduced here: satin's
// pullComp is a TOTAL width (width + pullComp), while the fill's is PER SIDE
// (the region grows by it on every edge, so a diameter grows by twice it).
// The same number therefore means different things on the two, which is worth
// knowing and is not something that can be quietly changed — it would alter
// what every design already in the shop sews.
//
// Pure and DOM-free.

import type { CompDefaults, EmbObject, Pt } from './model'
import { dedupe, dist, ringArea, ringInsideRing } from './geometry'

/**
 * What an object's compensation actually is, once the document is consulted.
 *
 * An absent field on the object means "follow the document" — see
 * CompDefaults for why that is an absent field rather than a null.
 */
export function resolveComp(
  own: { pullComp?: number; pushComp?: number } | undefined,
  doc: CompDefaults,
  kind: 'satin' | 'fill',
): { pull: number; push: number } {
  return {
    // Negative compensation is not a thing: it would shrink a shape that is
    // already going to sew small. Clamped rather than rejected, because a
    // stored -0.1 should sew something sane rather than nothing.
    pull: Math.max(0, own?.pullComp ?? (kind === 'satin' ? doc.satinPull : doc.fillPull)),
    push: Math.max(0, own?.pushComp ?? doc.push),
  }
}

/** True when this object carries its own value rather than following the document. */
export function hasOwnComp(own: { pullComp?: number; pushComp?: number } | undefined): boolean {
  return own?.pullComp !== undefined || own?.pushComp !== undefined
}

/**
 * Fill in an object's compensation from the document.
 *
 * Done once, at the boundary where the document meets the stitch engine, so
 * that satin.ts and fill.ts are handed concrete numbers and never have to
 * know that a default exists. The alternative — threading the document
 * through every generator — puts a document lookup inside geometry code,
 * which is where it would eventually be forgotten on one path.
 */
export function withComp(obj: EmbObject, doc: CompDefaults): EmbObject {
  const satin = resolveComp(obj.satin, doc, 'satin')
  const fill = resolveComp(obj.fill, doc, 'fill')
  return {
    ...obj,
    satin: { ...obj.satin, pullComp: satin.pull, pushComp: satin.push },
    fill: { ...obj.fill, pullComp: fill.pull, pushComp: fill.push },
  }
}

// ---------------------------------------------------------------------------
// Satin: push shortens the column
// ---------------------------------------------------------------------------

/**
 * Take `mm` off each end of an open path, along its own length.
 *
 * A CLOSED path has no ends, so there is nothing to trim and it comes back
 * untouched — a ring sewn as satin is pushed outward all the way round, and
 * the honest correction for that is the width, not the length.
 *
 * Returns the path unchanged if trimming would consume it. A column shorter
 * than twice its own push compensation is a tiny shape with a big correction,
 * and the right answer there is to sew it as drawn rather than to sew
 * nothing: the caller reports it.
 */
export function trimEnds(path: readonly Pt[], mm: number): Pt[] {
  const pts = dedupe(path.map((q) => ({ ...q })))
  if (mm <= 0 || pts.length < 2) return pts.map((p) => ({ ...p }))

  let total = 0
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i])
  // Leave something to sew: a whisker of column is still a column, nothing
  // is a disappeared object.
  if (total <= mm * 2 + 1e-6) return pts.map((p) => ({ ...p }))

  return cutFrom(cutFrom(pts, mm).reverse(), mm).reverse()
}

/** Walk `mm` in from the START of a path and drop everything before it. */
function cutFrom(pts: readonly Pt[], mm: number): Pt[] {
  let left = mm
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i])
    if (d < left) { left -= d; continue }
    // The new first point sits partway along this segment. Everything from
    // here on is kept as it was — only the end moves, so the curve the
    // digitizer drew is not resampled and softened by being trimmed.
    const t = d > 1e-12 ? left / d : 0
    const cut = {
      x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
      y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
    }
    return [cut, ...pts.slice(i).map((p) => ({ ...p }))]
  }
  return pts.slice(-1).map((p) => ({ ...p }))
}

// ---------------------------------------------------------------------------
// Fill: push insets across the rows only
// ---------------------------------------------------------------------------

export interface InsetResult {
  paths: Pt[][]
  /** True when the inset was abandoned and `paths` is the input unchanged. */
  failed: boolean
}

/**
 * Inset a region by `mm`, but only where its outline faces across the rows.
 *
 * `angleDeg` is the stitch angle — the direction the rows RUN. Push acts at
 * right angles to that, so the correction is scaled by how squarely each part
 * of the outline faces that way.
 *
 * The scaling is the SQUARE of the projection, not its absolute value. A
 * squared term is smooth through the point where the outline turns from
 * facing across the rows to facing along them; |cos| has a kink there, and a
 * kink in the displacement is a visible crease in the finished edge of a
 * circle. It also means a 45° edge is corrected by half rather than by 0.7,
 * which is the right answer: the distortion at 45° is shared between the two
 * effects.
 *
 * Holes move the opposite way, the same as any other inset — a hole in a
 * region that is being squeezed inward gets bigger.
 */
export function directionalInset(
  paths: readonly Pt[][],
  mm: number,
  angleDeg: number,
): InsetResult {
  if (mm <= 0 || !paths.length) return { paths: paths.map((r) => r.map((p) => ({ ...p }))), failed: false }

  const rad = (angleDeg * Math.PI) / 180
  // The direction push acts in: at right angles to the rows.
  const vx = -Math.sin(rad), vy = Math.cos(rad)

  // Which rings are holes, by containment — the same rule the offsetter uses,
  // and for the same reason: nothing re-winds rings that arrive from an SVG,
  // so winding cannot be trusted to say which way is "in".
  const areas = paths.map((r) => Math.abs(ringArea(r)))
  const isHole = paths.map((r, i) =>
    paths.reduce((d, o, j) => (j !== i && areas[j] > areas[i] && ringInsideRing(r, o) ? d + 1 : d), 0) % 2 === 1,
  )

  const out: Pt[][] = []
  for (let idx = 0; idx < paths.length; idx++) {
    const ring = dedupe(paths[idx].map((q) => ({ ...q })))
    if (ring.length > 2 && dist(ring[0], ring[ring.length - 1]) < 1e-6) ring.pop()
    const n = ring.length
    if (n < 3) { out.push(paths[idx].map((p) => ({ ...p }))); continue }

    // EDGES move, and the corners follow from where the moved edges meet.
    //
    // Displacing each vertex along its own bisector cannot express this: a
    // square's every vertex is a corner shared by one edge that must move and
    // one that must not, and a single point cannot satisfy both — the whole
    // square comes in uniformly, which is precisely the isotropic offset this
    // is supposed not to be. Offsetting the edge LINES and intersecting them
    // gives the corner only one place to be, and it is the right one.
    const move = (dir: number): Pt[] => {
      // How far each edge travels: full displacement where it faces across
      // the rows, nothing where it faces along them.
      const d: number[] = []
      for (let i = 0; i < n; i++) {
        const nm = unitNormal(ring[i], ring[(i + 1) % n])
        const facing = nm.x * vx + nm.y * vy
        d.push(mm * facing * facing * dir)
      }
      const moved: Pt[] = []
      for (let i = 0; i < n; i++) {
        // The vertex between edge i-1 and edge i.
        const h = (i - 1 + n) % n
        const a0 = ring[h], a1 = ring[(h + 1) % n]
        const b0 = ring[i], b1 = ring[(i + 1) % n]
        const na = unitNormal(a0, a1), nb = unitNormal(b0, b1)
        const pa = { x: a0.x + na.x * d[h], y: a0.y + na.y * d[h] }
        const pb = { x: b0.x + nb.x * d[i], y: b0.y + nb.y * d[i] }
        const ta = { x: a1.x - a0.x, y: a1.y - a0.y }
        const tb = { x: b1.x - b0.x, y: b1.y - b0.y }
        const det = ta.x * tb.y - ta.y * tb.x
        // Collinear or nearly so: the two lines have no single meeting point,
        // and on a smooth curve they are a hair apart anyway. Take the vertex
        // on its own edge's offset, which is where the limit lands.
        if (Math.abs(det) < 1e-9) { moved.push(pb); continue }
        const s0 = ((pb.x - pa.x) * tb.y - (pb.y - pa.y) * tb.x) / det
        moved.push({ x: pa.x + ta.x * s0, y: pa.y + ta.y * s0 })
      }
      return moved
    }

    // Decide the SIGN from what the displacement actually did to the area,
    // not from an assumed winding: an outline must lose area, a hole gain it.
    const signed = ringArea(ring)
    const before = Math.abs(signed)
    const a = move(1), b = move(-1)
    const areaA = Math.abs(ringArea(a)), areaB = Math.abs(ringArea(b))
    const want = isHole[idx] ? 1 : -1
    const pick = want < 0 ? (areaA < areaB ? a : b) : (areaA > areaB ? a : b)
    const afterSigned = ringArea(pick)
    const after = Math.abs(afterSigned)

    // A ring that collapsed or turned inside out is a shape too small for the
    // correction being asked of it. Keep the original and let the caller say
    // so — a vanished object is the worst possible outcome, because nothing
    // on screen explains it.
    //
    // The WINDING test is the one that matters, and area alone cannot do it:
    // a 2 x 0.4 sliver taken in by 3 mm comes out inside-out and BIGGER than
    // it started, so a check on size alone waves it through and the fill sews
    // a shape turned through itself.
    const inverted = Math.sign(afterSigned) !== Math.sign(signed)
    if (!isFinite(after) || inverted || after < before * 0.05) {
      return { paths: paths.map((r) => r.map((p) => ({ ...p }))), failed: true }
    }
    out.push(pick)
  }
  return { paths: out, failed: false }
}

/** The outward normal of the edge a->b. Same convention as the offsetter. */
function unitNormal(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x, dy = b.y - a.y
  const l = Math.hypot(dx, dy) || 1
  return { x: dy / l, y: -dx / l }
}
