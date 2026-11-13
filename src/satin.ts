// Satin, running and bean stitch — the line treatments.
//
// A satin column is a zigzag swung either side of a spine. gleEmbroidery
// builds it from the spine's NORMAL, sampled at the density pitch, so the
// column keeps its width around curves.
//
// Two things make satin look machine-made rather than generated:
//   * On an outside curve the penetrations fan apart and the coverage thins.
//     The sampling step is therefore reduced by the local curvature so the
//     OUTER rail keeps the requested density instead of the spine doing so.
//   * Pull compensation widens the column, because satin drags its edges in.

import { NO_SPLIT, SATIN_UNDERLAY_ORDER, orderedUnderlay, type PuffParams, type Pt, type RunParams, type SatinParams, type SatinUnderlay } from './model'
import type { Stitch } from './stitches'
import { dedupe, dist, isClosed, pathLength, resample, tangentAt } from './geometry'

/** Hard floor on same-rail penetration spacing, mm. Below this is one hole. */
export const MIN_RAIL_MM = 0.3

/**
 * Bar lean used by the faux overlock edge, degrees.
 *
 * Around 45 is what a serger actually produces, and it is also the angle at
 * which the bars still cover the edge: lean much further and consecutive bars
 * stop overlapping, leaving the cut edge showing between them.
 */
export const OVERLOCK_LEAN = 45

/**
 * How far a bar may be turned off perpendicular, degrees.
 *
 * Past roughly this, consecutive bars stop overlapping and the column shows
 * fabric between them; it is also where the bar gets long enough
 * (width / cos angle) to start snagging. Applies to the lean and to angle
 * guides alike, because they are the same quantity.
 */
export const MAX_BAR_ANGLE = 70

/** Arc length over which curvature is measured, mm. */
const CURV_WINDOW_MM = 0.6

// ---------------------------------------------------------------------------
// Manual angle guides
// ---------------------------------------------------------------------------
//
// By default every bar crosses the spine at a right angle, which is correct
// for a plain column and wrong for most real lettering: on a serif, a leaf, or
// the join of a script letter the digitizer decides which way the stitches
// run, because the direction is what catches the light and what hides the
// join. An angle guide is the way that decision is stated — a line drawn
// ACROSS the column where the bars should follow it.
//
// Guides are stored as plain segments in document mm and attached to the
// spine by projection, so they keep meaning when the spine is reshaped: move
// a node and the guide still describes the same place on the column.
//
// THE ANGLE IS STORED RELATIVE TO THE LOCAL NORMAL, not as an absolute
// compass direction. On a curved column an absolute angle would mean a
// different thing at every point and the bars would fan and cross; relative
// to the normal, "20 degrees off square" stays 20 degrees off square all the
// way round the bend.

/** A line drawn across a column stating which way the bars should run. */
export interface AngleGuide {
  a: Pt
  b: Pt
}

/** A guide resolved onto a spine: where it lands, and how far off square. */
export interface ResolvedGuide {
  /** Arc length along the spine, mm. */
  s: number
  /** Angle from the local normal, radians, positive toward the tangent. */
  rel: number
}

/** Closest point on a polyline to p, as (arc length, distance). */
function projectOnto(pts: Pt[], cum: number[], p: Pt): { s: number; d: number; i: number; t: number } {
  let best = { s: 0, d: Infinity, i: 1, t: 0 }
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const dx = b.x - a.x, dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 > 1e-12
      ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
      : 0
    const qx = a.x + dx * t, qy = a.y + dy * t
    const d = Math.hypot(p.x - qx, p.y - qy)
    if (d < best.d) best = { s: cum[i - 1] + Math.sqrt(len2) * t, d, i, t }
  }
  return best
}

/**
 * Attach guides to a spine.
 *
 * A guide is placed by its MIDPOINT, because that is the part of it the user
 * put on the column; the ends are where they need to be to show the angle.
 * Guides whose midpoint misses the column by more than `reach` are dropped and
 * reported — a guide floating in space is a mistake, and silently snapping it
 * to the nearest point would put the angle somewhere nobody asked for.
 */
export function resolveGuides(
  spine: Pt[], guides: readonly AngleGuide[], closed: boolean, reach: number,
  onDrop?: (g: AngleGuide, d: number) => void,
): ResolvedGuide[] {
  const pts = dedupe(spine)
  if (pts.length < 2) return []
  const cum = cumulative(pts)
  const out: ResolvedGuide[] = []
  for (const g of guides) {
    const mid = { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 }
    const hit = projectOnto(pts, cum, mid)
    if (hit.d > reach) { onDrop?.(g, hit.d); continue }
    const dir = unit(g.a, g.b)
    if (!isFinite(dir.x) || !isFinite(dir.y)) continue
    // Nearest spine sample, for the local frame.
    const i = hit.t >= 0.5 ? hit.i : hit.i - 1
    const t = tangentAt(pts, Math.max(0, Math.min(pts.length - 1, i)), closed)
    const n = { x: -t.y, y: t.x }
    // Angle from the normal toward the tangent.
    let rel = Math.atan2(dir.x * t.x + dir.y * t.y, dir.x * n.x + dir.y * n.y)
    // A guide has no head or tail — drawing it the other way round must mean
    // the same angle, so fold it into the half-turn around the normal.
    if (rel > Math.PI / 2) rel -= Math.PI
    if (rel < -Math.PI / 2) rel += Math.PI
    const cap = (MAX_BAR_ANGLE * Math.PI) / 180
    out.push({ s: hit.s, rel: Math.max(-cap, Math.min(cap, rel)) })
  }
  return out.sort((x, y) => x.s - y.s)
}

/** How far from a column a guide may sit and still be taken as meant for it. */
export const GUIDE_REACH_MM = 3

/**
 * Give each guide to the ONE path it was drawn across.
 *
 * A satin object can hold several unrelated strokes. A guide is for one of
 * them, and handing every guide to every stroke would both turn bars nobody
 * asked to turn and report each guide as off-column for all the strokes it
 * was not drawn on.
 *
 * `reach` scales with the column so a wide one still accepts a guide drawn
 * through it; a guide beyond every path comes back as an orphan rather than
 * being snapped to the nearest, because snapping would silently put the angle
 * somewhere nobody chose.
 */
export function assignGuides(
  paths: readonly Pt[][], guides: readonly AngleGuide[], reach = GUIDE_REACH_MM,
): { byPath: Map<Pt[], AngleGuide[]>; orphans: { guide: AngleGuide; d: number }[] } {
  const byPath = new Map<Pt[], AngleGuide[]>()
  const orphans: { guide: AngleGuide; d: number }[] = []
  const walks = paths.map((p) => {
    const pts = dedupe(p)
    return pts.length >= 2 ? { path: p, pts, cum: cumulative(pts) } : null
  })
  for (const g of guides) {
    const mid = { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 }
    let best: { path: Pt[]; d: number } | null = null
    for (const w of walks) {
      if (!w) continue
      const d = projectOnto(w.pts, w.cum, mid).d
      if (!best || d < best.d) best = { path: w.path, d }
    }
    if (!best || best.d > reach) { orphans.push({ guide: g, d: best?.d ?? Infinity }); continue }
    const list = byPath.get(best.path)
    if (list) list.push(g); else byPath.set(best.path, [g])
  }
  return { byPath, orphans }
}

/**
 * Bar angle at arc length `s`, interpolating between guides.
 *
 * Outside the outermost guides the nearest guide's angle is HELD rather than
 * decayed back to square. A digitizer who sets one angle on a stroke means it
 * for the stroke, and fading to perpendicular at the ends would twist exactly
 * the part of a letter where the direction matters most.
 */
export function angleAt(guides: readonly ResolvedGuide[], s: number, fallback: number): number {
  if (!guides.length) return fallback
  if (s <= guides[0].s) return guides[0].rel
  const last = guides[guides.length - 1]
  if (s >= last.s) return last.rel
  for (let i = 1; i < guides.length; i++) {
    const a = guides[i - 1], b = guides[i]
    if (s > b.s) continue
    const span = b.s - a.s
    const f = span > 1e-9 ? (s - a.s) / span : 0
    return a.rel + (b.rel - a.rel) * f
  }
  return last.rel
}

/** Cumulative arc length along a polyline. */
function cumulative(pts: Pt[]): number[] {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]))
  return cum
}

/**
 * Menger curvature at sample i, using neighbours about `window` mm away.
 *
 * Three points define a circle; its reciprocal radius is 4*area/(a*b*c).
 * Taking the neighbours at a fixed ARC DISTANCE rather than at i±1 makes the
 * estimate independent of how finely the source path happened to be
 * flattened, which is the whole point.
 */
function curvatureAt(pts: Pt[], cum: number[], i: number, window: number): number {
  const n = pts.length
  if (n < 3) return 0
  let a = i, b = i
  while (a > 0 && cum[i] - cum[a] < window) a--
  while (b < n - 1 && cum[b] - cum[i] < window) b++
  if (a === i || b === i) return 0
  const P = pts[a], Q = pts[i], R = pts[b]
  const la = dist(P, Q), lb = dist(Q, R), lc = dist(P, R)
  if (la < 1e-9 || lb < 1e-9 || lc < 1e-9) return 0
  const cross = (Q.x - P.x) * (R.y - P.y) - (Q.y - P.y) * (R.x - P.x)
  return (2 * Math.abs(cross)) / (la * lb * lc)
}

/** Single running stitch along a path. */
export function runStitch(path: Pt[], p: RunParams): Stitch[] {
  const pts = dedupe(path)
  if (pts.length < 2) return []
  return resample(pts, Math.max(0.5, p.length))
}

/**
 * Bean (triple) stitch: each step is sewn forward, back, forward, so the line
 * reads three threads thick. Used for outlines that must hold their own.
 */
export function beanStitch(path: Pt[], p: RunParams): Stitch[] {
  const base = runStitch(path, p)
  if (base.length < 2) return base
  const out: Stitch[] = [base[0]]
  for (let i = 1; i < base.length; i++) {
    out.push(base[i], base[i - 1], base[i])
  }
  return out
}

/**
 * Satin column centred on `path`.
 *
 * The step along the spine is shrunk where the path curves, so that on the
 * outside of a bend the rail that actually shows still gets a penetration
 * every `density` mm. maxWidth guards the snag limit — anything wider than
 * ~10 mm should be a fill, and the caller is told so rather than it silently
 * producing stitches that catch on everything.
 */
/** Turn beyond this is a CORNER, not curvature, and gets mitred. */
export const CORNER_RAD = (25 * Math.PI) / 180

const unit = (a: Pt, b: Pt): Pt => {
  const dx = b.x - a.x, dy = b.y - a.y
  const l = Math.hypot(dx, dy) || 1
  return { x: dx / l, y: dy / l }
}

const turnBetween = (t1: Pt, t2: Pt) =>
  Math.atan2(t1.x * t2.y - t1.y * t2.x, t1.x * t2.x + t1.y * t2.y)

/**
 * Interior vertices where the path turns sharply enough to need a mitre.
 *
 * Deliberately per-vertex. A right angle that survived SVG flattening often
 * arrives split across two vertices — 74 degrees then 16, say. The large half
 * is caught here and mitred; the small remainder is left inside the adjoining
 * smooth run, where satinCheck ignores it because it falls within a
 * half-width of the corner. Clustering the two instead skipped over genuine
 * neighbouring corners on a clean box.
 */
export function findCorners(pts: Pt[]): number[] {
  const out: number[] = []
  for (let i = 1; i < pts.length - 1; i++) {
    const t1 = unit(pts[i - 1], pts[i]), t2 = unit(pts[i], pts[i + 1])
    if (Math.abs(turnBetween(t1, t2)) > CORNER_RAD) out.push(i)
  }
  return out
}

/**
 * The smooth part of a column: a spine with no corners in it.
 * Returns the stitches and the side the next one should start on, so a column
 * split at corners keeps alternating across the join.
 */
function smoothColumn(
  pts: Pt[], p: SatinParams, closed: boolean, startSide: number,
  guides: readonly ResolvedGuide[] = [], sOffset = 0,
): { stitches: Stitch[]; side: number } {
  const half = (p.width + p.pullComp) / 2
  const density = Math.max(0.1, p.density)
  const fine = resample(pts, Math.min(0.15, density / 3))
  if (fine.length < 2) return { stitches: [], side: startSide }
  const cum = cumulative(fine)
  // The bar's angle off square: the uniform lean by default, or whatever the
  // guides say at this point on the column. They are the same quantity, so a
  // guide simply overrides the lean where one has been placed.
  const cap = (MAX_BAR_ANGLE * Math.PI) / 180
  const leanRad = Math.max(-cap, Math.min(cap, ((p.lean || 0) * Math.PI) / 180))
  const barAngle = (i: number) => angleAt(guides, cum[i] + sOffset, leanRad)

  const out: Stitch[] = []
  let side = startSide
  let carried = 0

  for (let i = 0; i < fine.length; i++) {
    const t = tangentAt(fine, i, closed)
    const n = { x: -t.y, y: t.x }

    if (i > 0) {
      carried += dist(fine[i - 1], fine[i])
      // On a bend of radius r the outer rail travels (r+half)/r times as far,
      // so the spine must step that much SHORTER to hold the outer density.
      // Curvature is measured over a WINDOW of arc length, not between
      // adjacent samples: a flattened curve carries its whole turn at the
      // original vertices, so an adjacent-sample estimate reads zero almost
      // everywhere and spikes at one sample.
      const curvature = curvatureAt(fine, cum, i, CURV_WINDOW_MM)
      const widen = 1 + curvature * half
      // Shortening the step to hold the OUTER rail's density crowds the INNER
      // rail by the same factor. Unclamped, a 2 mm-radius arc at 2.5 mm width
      // lands inner penetrations 0.13 mm apart — one hole, a shredded thread
      // and usually a broken needle.
      const narrow = Math.max(0, 1 - curvature * half)
      const innerStep = density / Math.max(1, widen)
      const step = narrow > 1e-6 && innerStep * narrow < MIN_RAIL_MM
        ? MIN_RAIL_MM / narrow
        : innerStep
      if (carried + 1e-12 < step) continue
      carried = Math.max(0, carried - step)
    }

    // Turning a bar off square means sliding each penetration ALONG the path,
    // in opposite directions on the two rails. The shift is half*tan(angle),
    // which is exactly what turns a perpendicular bar into one at `angle` —
    // and it lengthens the bar to half/cos(angle), so the column still spans
    // the same width ACROSS.
    const slide = half * Math.tan(barAngle(i)) * side
    out.push({
      x: fine[i].x + n.x * half * side + t.x * slide,
      y: fine[i].y + n.y * half * side + t.y * slide,
    })
    side = -side
  }

  // Land the far end squarely rather than wherever the rhythm happened to be.
  const last = fine[fine.length - 1]
  const tl = tangentAt(fine, fine.length - 1, closed)
  const nl = { x: -tl.y, y: tl.x }
  const tailSlide = half * Math.tan(barAngle(fine.length - 1)) * side
  const tail = {
    x: last.x + nl.x * half * side + tl.x * tailSlide,
    y: last.y + nl.y * half * side + tl.y * tailSlide,
  }
  if (!out.length || dist(out[out.length - 1], tail) > 1e-6) {
    out.push(tail)
    side = -side
  }
  return { stitches: out, side }
}

/**
 * A mitred corner.
 *
 * A satin column cannot be swung round a sharp vertex: the inner rail would
 * need a turn radius smaller than the column's own half-width, so it folds
 * through itself — thread piles inside the corner, the needle strikes, and
 * outside there is a visible notch. The fix is the one a digitizer does by
 * hand: hold the INNER rail on a single mitre point and fan the OUTER rail
 * through the turn.
 *
 * The inner points are spread along the bisector rather than stacked in one
 * hole, so the fan does not become a single perforation.
 */
function cornerFan(pts: Pt[], i: number, p: SatinParams, startSide: number):
  { stitches: Stitch[]; side: number } {
  const half = (p.width + p.pullComp) / 2
  const density = Math.max(0.1, p.density)
  const c = pts[i]
  const t1 = unit(pts[i - 1], c), t2 = unit(c, pts[i + 1])
  const n1 = { x: -t1.y, y: t1.x }, n2 = { x: -t2.y, y: t2.x }
  const turn = turnBetween(t1, t2)

  // Which side is the inside of the turn? The normals' bisector agrees with
  // the interior bisector (t2 - t1) on the concave side.
  let bx = n1.x + n2.x, by = n1.y + n2.y
  const bl = Math.hypot(bx, by)
  if (bl < 1e-9) return { stitches: [], side: startSide }
  bx /= bl; by /= bl
  const ix = t2.x - t1.x, iy = t2.y - t1.y
  const il = Math.hypot(ix, iy) || 1
  const innerSign = bx * (ix / il) + by * (iy / il) >= 0 ? 1 : -1
  const outerSign = -innerSign

  // Mitre length, clamped so a very sharp corner does not throw a long spike.
  const cosHalf = Math.max(0.3, Math.cos(Math.abs(turn) / 2))
  const mitre = Math.min(half / cosHalf, half * 2.5)

  // How many stitches the fan can hold. The OUTER rail wants one every
  // `density` along its arc; the INNER rail is the constraint, because its
  // points are squeezed between the column edge and the mitre point and two
  // of them in one hole is the thing this whole routine exists to avoid.
  const arc = Math.abs(turn) * half
  const innerSpan = Math.max(0, mitre - half)
  const maxInner = Math.max(1, Math.floor(innerSpan / MIN_RAIL_MM) + 1)
  const steps = Math.max(2, Math.min(Math.ceil(arc / density), maxInner * 2))

  // Which steps land on the inner rail, so they can be spread across the WHOLE
  // mitre span rather than over the fraction of it their sweep position
  // happens to fall in.
  const innerKs: number[] = []
  for (let k = 1, sd = startSide; k <= steps; k++, sd = -sd) if (sd !== outerSign) innerKs.push(k)

  const out: Stitch[] = []
  let side = startSide
  let innerSeen = 0
  // Start at k=1: k=0 lands exactly where the incoming column's last stitch
  // already is, and a repeated penetration is a hole, not a stitch.
  for (let k = 1; k <= steps; k++) {
    const f = k / steps
    if (side === outerSign) {
      // Outer rail sweeps the turn.
      const a = Math.atan2(n1.y, n1.x) + turn * f
      out.push({ x: c.x + Math.cos(a) * half * outerSign, y: c.y + Math.sin(a) * half * outerSign })
    } else {
      // Inner rail walks out along the bisector to the mitre point, using the
      // full span so consecutive inner holes stay MIN_RAIL_MM apart.
      const g = innerKs.length > 1 ? innerSeen / (innerKs.length - 1) : 1
      const d = innerSpan > 1e-9 ? half + innerSpan * g : half
      out.push({ x: c.x + bx * d * innerSign, y: c.y + by * d * innerSign })
      innerSeen++
    }
    side = -side
  }
  return { stitches: out, side }
}

/**
 * Satin column centred on `path`.
 *
 * Smooth runs are generated with curvature-corrected spacing; sharp vertices
 * are mitred. Geometry that still cannot be sewn is refused by satinCheck
 * before this is ever called.
 */
export function satinColumn(
  path: Pt[], p: SatinParams, guides: readonly AngleGuide[] = [],
  onDrop?: (g: AngleGuide, d: number) => void,
): Stitch[] {
  const pts = dedupe(path)
  if (pts.length < 2) return []
  if ((p.width + p.pullComp) / 2 <= 0) return []
  const closed = isClosed(path)

  // Resolved against the WHOLE spine, once, so arc length means the same
  // thing in every segment the corners split it into.
  const half = (p.width + p.pullComp) / 2
  const resolved = guides.length
    ? resolveGuides(pts, guides, closed, Math.max(half * 2, GUIDE_REACH_MM), onDrop)
    : []
  const cumAll = cumulative(pts)

  const corners = findCorners(pts)
  if (!corners.length) {
    return applySatinSplit(smoothColumn(pts, p, closed, 1, resolved, 0).stitches, p)
  }

  const out: Stitch[] = []
  let side = 1
  let from = 0
  for (const c of corners) {
    const seg = pts.slice(from, c + 1)
    if (seg.length >= 2) {
      const r = smoothColumn(seg, p, false, side, resolved, cumAll[from])
      out.push(...r.stitches)
      side = r.side
    }
    const f = cornerFan(pts, c, p, side)
    out.push(...f.stitches)
    side = f.side
    from = c
  }
  const tailSeg = pts.slice(from)
  if (tailSeg.length >= 2) {
    out.push(...smoothColumn(tailSeg, p, false, side, resolved, cumAll[from]).stitches)
  }
  return applySatinSplit(out, p)
}

// ---------------------------------------------------------------------------
// Satin splitting
// ---------------------------------------------------------------------------
//
// A satin bar is one stitch from rail to rail, so the column's width IS the
// stitch length. Past about 10 mm that stitch catches on everything — a
// fingernail, a seatbelt, a washing machine — and pulls, which is why a wide
// column is otherwise refused outright.
//
// Splitting is the way a digitizer sews a wide column anyway: each bar is
// broken into two or more stitches, with a penetration partway across. The
// thread still lies in one direction and still reads as satin, but no single
// stitch is long enough to snag.
//
// THE SPLIT POINTS MUST STAGGER. Put them all at the same fraction across and
// the column grows a visible seam down its middle — a line of needle holes in
// a surface whose whole appeal is being unbroken. Staggering scatters them so
// no line forms. It is done from a deterministic phase, NOT from random
// numbers: the same design must always produce the same stitch file.

/** Widest column that still makes sense as a SPLIT satin, mm. Past this, fill. */
export const MAX_SPLIT_SATIN_MM = 30

/**
 * Break bars longer than `maxLength` into sewable pieces.
 *
 * A post-pass over emitted stitches rather than something woven into each
 * generator: every satin engine here emits a flat list in which consecutive
 * points are the ends of a bar, so one pass covers the spine column, the
 * two-rail column and the mitred corners alike.
 */
export function applySatinSplit(stitches: Stitch[], p: SatinParams): Stitch[] {
  const sp = p.split
  if (!sp?.enabled || stitches.length < 2) return stitches
  const maxLength = Math.max(1, sp.maxLength)
  const stagger = Math.max(0, Math.min(1, sp.stagger))
  const out: Stitch[] = [stitches[0]]
  for (let i = 1; i < stitches.length; i++) {
    const a = stitches[i - 1], b = stitches[i]
    const L = Math.hypot(b.x - a.x, b.y - a.y)
    if (b.jump || a.jump || L <= maxLength) { out.push(b); continue }
    // The golden ratio spreads consecutive bars across the whole stagger
    // range without ever repeating a phase — the same job random numbers
    // would do, and reproducible, which they are not.
    const phase = (i * 0.6180339887) % 1
    const shift = (phase - 0.5) * stagger
    // Count the pieces from the WORST case, so the shift cannot push a piece
    // back over the limit the split exists to respect.
    const n = Math.max(2, Math.ceil((L * (1 + Math.abs(shift))) / maxLength))
    for (let k = 1; k < n; k++) {
      const f = Math.max(0.05, Math.min(0.95, (k + shift) / n))
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, split: true })
    }
    out.push(b)
  }
  return out
}

/** Satin's underlay options, all laid on the spine before the column. */
export function satinUnderlay(path: Pt[], p: SatinParams): Stitch[] {
  const pts = dedupe(path)
  if (pts.length < 2) return []
  // Layers sew in a fixed craft order, not the order they were ticked.
  const out: Stitch[] = []
  for (const layer of orderedUnderlay(p.underlay ?? [], SATIN_UNDERLAY_ORDER)) {
    out.push(...satinUnderlayLayer(pts, p, layer))
  }
  return out
}

function satinUnderlayLayer(pts: Pt[], p: SatinParams, layer: SatinUnderlay): Stitch[] {
  switch (layer) {
    case 'center':
      // A plain run down the middle gives the column something to sit on.
      return resample(pts, 2.0)
    case 'edge': {
      // Runs just inside each rail, there and back.
      const inset = Math.max(0.2, (p.width + p.pullComp) / 2 - 0.4)
      const closed = isClosed(pts)
      const fine = resample(pts, 2.0)
      const left: Stitch[] = [], right: Stitch[] = []
      for (let i = 0; i < fine.length; i++) {
        const t = tangentAt(fine, i, closed)
        const n = { x: -t.y, y: t.x }
        left.push({ x: fine[i].x + n.x * inset, y: fine[i].y + n.y * inset })
        right.push({ x: fine[i].x - n.x * inset, y: fine[i].y - n.y * inset })
      }
      return [...left, ...right.reverse()]
    }
    case 'zigzag':
      // A sparse satin at about half the width — the standard base under a
      // wide column, holding the nap down before the top stitching.
      return satinColumn(pts, {
        width: Math.max(0.6, p.width * 0.6),
        density: Math.max(1.2, p.density * 3),
        pullComp: 0,
        underlay: [],
        // Underlay is never leaned: it is structural, and a slanted underlay
        // would show through the top stitching it is meant to hide under.
        lean: 0,
        split: NO_SPLIT(),
      })
    default:
      return []
  }
}

/** Widest satin that will not snag in wear, mm. Past this, use a fill. */
// ---------------------------------------------------------------------------
// Two-rail columns
// ---------------------------------------------------------------------------
//
// The column above is a SPINE plus a width: the two rails are derived, so the
// column is the same width everywhere and the digitizer has no say in where
// the edges actually run. A real satin — a serif, a leaf, the thick-to-thin of
// a script letter — is drawn as its two EDGES, and its width is whatever the
// gap between them happens to be at each point.
//
// Giving the rails directly removes every derived quantity the spine version
// has to infer. There is no curvature correction here and no mitre, because
// there is nothing to infer: the edges are stated, and the only question left
// is how to PAIR them.
//
// Pairing is by proportional arc length. Stitch k lands at the same fraction
// along each rail, which is what makes a taper come out as a taper rather than
// as a column that runs out of one rail before the other.

/** Resample a rail to a fine, even walk plus its cumulative lengths. */
function railWalk(rail: Pt[], step: number): { pts: Pt[]; cum: number[]; len: number } {
  const pts = resample(dedupe(rail), step)
  const cum = cumulative(pts)
  return { pts, cum, len: cum[cum.length - 1] ?? 0 }
}

/** Point at a given fraction along a pre-walked rail. */
function atFraction(w: { pts: Pt[]; cum: number[]; len: number }, u: number): Pt {
  if (w.pts.length === 0) return { x: 0, y: 0 }
  if (w.len <= 1e-9) return w.pts[0]
  const target = Math.max(0, Math.min(1, u)) * w.len
  // The walk is even, so a linear guess lands within a sample or two.
  let i = Math.min(w.cum.length - 1, Math.max(1, Math.round((target / w.len) * (w.cum.length - 1))))
  while (i > 1 && w.cum[i - 1] > target) i--
  while (i < w.cum.length - 1 && w.cum[i] < target) i++
  const a = w.pts[i - 1], b = w.pts[i]
  const span = w.cum[i] - w.cum[i - 1]
  const t = span > 1e-12 ? (target - w.cum[i - 1]) / span : 0
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/**
 * Should rail B be reversed before pairing?
 *
 * A digitizer draws the second rail whichever way feels natural, and half the
 * time that is back towards the start. Pairing those as given twists the
 * column into a bow tie whose stitches cross in the middle — the single most
 * common way a two-rail satin goes wrong. Comparing the two possible pairings
 * end-to-end costs nothing and removes the trap entirely.
 */
export function railsNeedFlip(a: Pt[], b: Pt[]): boolean {
  if (a.length < 2 || b.length < 2) return false
  const a0 = a[0], a1 = a[a.length - 1]
  const b0 = b[0], b1 = b[b.length - 1]
  const asIs = dist(a0, b0) + dist(a1, b1)
  const flipped = dist(a0, b1) + dist(a1, b0)
  return flipped < asIs
}

/** Widen a pairing by pullComp, pushing each rail away from the other. */
function compensate(pa: Pt, pb: Pt, outward: number): [Pt, Pt] {
  if (outward <= 0) return [pa, pb]
  const dx = pb.x - pa.x, dy = pb.y - pa.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return [pa, pb]
  const ux = dx / len, uy = dy / len
  return [
    { x: pa.x - ux * outward, y: pa.y - uy * outward },
    { x: pb.x + ux * outward, y: pb.y + uy * outward },
  ]
}

/**
 * Zigzag between two drawn rails.
 *
 * Density is held on whichever rail is locally LONGER — the outer edge of a
 * bend — because that is the edge the eye reads and the one that goes gappy
 * first. The inner rail is then crowded by the same ratio, so it is clamped at
 * MIN_RAIL_MM exactly as the spine version is: past that point the holes merge
 * into one perforation, which shreds thread and breaks needles. When the clamp
 * binds, the outer edge goes slightly sparser rather than the inner edge
 * being destroyed — the same trade, made for the same reason.
 */
/**
 * Build a reparameterisation from explicit rung anchors.
 *
 * Returns a function from GLOBAL t (0..1, shared by both rails) to that
 * rail's own fraction u. With anchors, rung k sits at t = k/(n-1) on BOTH
 * rails, so the pair the digitizer clicked stays paired no matter how
 * differently the two edges run between rungs — which is the entire point of
 * clicking alternate sides instead of drawing two independent curves.
 *
 * Without anchors it is the identity, which is the proportional-arc-length
 * pairing used for rails that arrived separately (a trace, an import).
 */
function reparam(anchors?: readonly number[]): (t: number) => number {
  if (!anchors || anchors.length < 2) return (t) => t
  const n = anchors.length - 1
  return (t: number) => {
    const x = Math.max(0, Math.min(1, t)) * n
    const k = Math.min(n - 1, Math.floor(x))
    const f = x - k
    return anchors[k] + (anchors[k + 1] - anchors[k]) * f
  }
}

export interface TwoRailOptions {
  /** Fraction along rail A of each rung anchor, ascending, 0..1. */
  anchorsA?: readonly number[]
  /** The matching fractions along rail B. Same length as anchorsA. */
  anchorsB?: readonly number[]
}

export function satinTwoRail(
  railA: Pt[], railB: Pt[], p: SatinParams, opt: TwoRailOptions = {},
): Stitch[] {
  const a = dedupe(railA)
  const bRaw = dedupe(railB)
  if (a.length < 2 || bRaw.length < 2) return []
  const b = railsNeedFlip(a, bRaw) ? [...bRaw].reverse() : bRaw

  const density = Math.max(0.1, p.density)
  const fine = Math.min(0.15, density / 3)
  const wa = railWalk(a, fine)
  const wb = railWalk(b, fine)
  if (wa.len <= 1e-9 && wb.len <= 1e-9) return []
  const outward = Math.max(0, p.pullComp) / 2

  const toA = reparam(opt.anchorsA)
  const toB = reparam(opt.anchorsB)

  const out: Stitch[] = []
  /** Which rail each emitted stitch landed on; needed to close out cleanly. */
  const sides: number[] = []
  let u = 0
  let side = 0
  let guard = 0
  // Walk the pair by fraction. Each step is sized from the LOCAL speed of both
  // rails, not from their total lengths — a column can be wide at one end and
  // pinched at the other, and a single global step would be wrong at both.
  while (u < 1 && guard++ < 200000) {
    const pa = atFraction(wa, toA(u))
    const pb = atFraction(wb, toB(u))
    const [ca, cb] = compensate(pa, pb, outward)
    out.push(side === 0 ? { x: ca.x, y: ca.y } : { x: cb.x, y: cb.y })
    sides.push(side)
    side ^= 1

    // Probe a small step ahead to measure how fast each rail is moving here.
    const probe = Math.min(1 - u, Math.max(1e-6, density / Math.max(wa.len, wb.len, 1e-9)))
    if (probe <= 1e-9) break
    const sa = dist(pa, atFraction(wa, toA(u + probe)))
    const sb = dist(pb, atFraction(wb, toB(u + probe)))
    const fast = Math.max(sa, sb)
    const slow = Math.min(sa, sb)
    let du = fast > 1e-9 ? probe * (density / fast) : probe
    // Clamp so the inner rail keeps a sewable gap between penetrations.
    if (slow > 1e-9) {
      const innerStep = slow * (du / probe)
      if (innerStep < MIN_RAIL_MM) du = probe * (MIN_RAIL_MM / slow)
    }
    u += Math.max(du, 1e-7)
  }

  // Land the far end squarely on both rails rather than wherever the rhythm
  // ran out, so the column finishes with a clean bar instead of a notch.
  //
  // The closing bar is FORCED, so wherever the walk happened to stop it can
  // land a hair from the previous penetration on that same rail. Those get
  // dropped first: a stitch 0.1 mm from its neighbour is not a stitch, it is
  // a second strike in the same hole, and the whole point of MIN_RAIL_MM is
  // that such a pair shreds thread and breaks needles.
  const ends = compensate(atFraction(wa, toA(1)), atFraction(wb, toB(1)), outward)
  while (out.length && dist(out[out.length - 1], ends[sides[sides.length - 1]]) < MIN_RAIL_MM) {
    out.pop()
    sides.pop()
  }
  const lastSide = sides.length ? sides[sides.length - 1] : 1
  const first = lastSide === 0 ? 1 : 0
  if (!out.length || dist(out[out.length - 1], ends[first]) > 1e-9) out.push(ends[first])
  const second = first === 0 ? 1 : 0
  if (dist(out[out.length - 1], ends[second]) > 1e-9) out.push(ends[second])
  return applySatinSplit(out, p)
}

/**
 * Underlay under a two-rail column, layered.
 *
 * The spine of a two-rail column is not drawn, it is IMPLIED — the midline of
 * the pairing — and the rails are known exactly, so each layer can be built
 * from the real geometry rather than approximated from a width:
 *   centre  a run along the midline
 *   edge    runs just inside each rail, there and back
 *   zigzag  a sparse column between inset rails, to lift the nap
 * Every layer is inset from the ends and sides so none of it can show past
 * the satin it is meant to sit under.
 */
export function satinTwoRailUnderlay(
  railA: Pt[], railB: Pt[], p: SatinParams, opt: TwoRailOptions = {},
): Stitch[] {
  const layers = orderedUnderlay(p.underlay ?? [], SATIN_UNDERLAY_ORDER)
  if (!layers.length) return []
  const a = dedupe(railA)
  const bRaw = dedupe(railB)
  if (a.length < 2 || bRaw.length < 2) return []
  const b = railsNeedFlip(a, bRaw) ? [...bRaw].reverse() : bRaw
  const fine = Math.min(0.15, Math.max(0.1, p.density) / 3)
  const wa = railWalk(a, fine)
  const wb = railWalk(b, fine)

  const toA = reparam(opt.anchorsA)
  const toB = reparam(opt.anchorsB)

  /** Walk the pair, returning points at a fraction ACROSS the column. */
  const across = (t: number, steps = 48): Pt[] => {
    const out: Pt[] = []
    for (let i = 0; i <= steps; i++) {
      // Inset along the length so the underlay stops short of both ends.
      const u = 0.03 + (i / steps) * 0.94
      const pa = atFraction(wa, toA(u)), pb = atFraction(wb, toB(u))
      out.push({ x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t })
    }
    return out
  }

  const out: Stitch[] = []
  for (const layer of layers) {
    if (layer === 'center') {
      out.push(...runStitch(across(0.5), { length: 2.5, style: 'plain' }))
    } else if (layer === 'edge') {
      // A fraction in from each rail rather than a fixed millimetre inset:
      // the column tapers, so a fixed inset would cross the middle wherever
      // the rails pinch and sew the underlay outside the column.
      const left = runStitch(across(0.18), { length: 2.5, style: 'plain' })
      const right = runStitch(across(0.82), { length: 2.5, style: 'plain' })
      out.push(...left, ...right.reverse())
    } else {
      // Sparse zigzag between the inset rails.
      const l = across(0.2, 96), r = across(0.8, 96)
      const step = Math.max(2, Math.round(96 / Math.max(2, Math.floor(96 / 6))))
      for (let i = 0, side = 0; i < l.length; i += step, side ^= 1) {
        out.push(side === 0 ? l[i] : r[i])
      }
      out.push(out.length % 2 === 0 ? r[r.length - 1] : l[l.length - 1])
    }
  }
  return out
}

/** Width of a two-rail column at a few places along it, for checking. */
export function twoRailWidths(railA: Pt[], railB: Pt[], samples = 32): number[] {
  const a = dedupe(railA)
  const bRaw = dedupe(railB)
  if (a.length < 2 || bRaw.length < 2) return []
  const b = railsNeedFlip(a, bRaw) ? [...bRaw].reverse() : bRaw
  const wa = railWalk(a, 0.2)
  const wb = railWalk(b, 0.2)
  const out: number[] = []
  for (let i = 0; i <= samples; i++) {
    const u = i / samples
    out.push(dist(atFraction(wa, u), atFraction(wb, u)))
  }
  return out
}

/**
 * Check a two-rail column before generating it.
 *
 * The spine version's curvature test does not apply — there is no inferred
 * rail to fold. What CAN be wrong here is the pair: rails too far apart to
 * sew, pinched to nothing, or crossing each other.
 */
export function twoRailCheck(railA: Pt[], railB: Pt[], p: SatinParams): SatinCheck {
  const errors: string[] = []
  const warnings: string[] = []
  const widths = twoRailWidths(railA, railB)
  if (widths.length === 0) {
    errors.push('a two-rail column needs two rails of at least two points each')
    return { errors, warnings }
  }
  const comp = Math.max(0, p.pullComp)
  const widest = Math.max(...widths) + comp
  const narrowest = Math.min(...widths) + comp
  // Same rule as the spine column: splitting is what makes a wide bar
  // sewable, so the limit depends on whether it is on.
  if (p.split?.enabled) {
    if (p.split.maxLength > MAX_SATIN_MM) {
      errors.push(
        `split length ${p.split.maxLength.toFixed(1)} mm is itself over the ${MAX_SATIN_MM} mm ` +
          'limit — splitting there does not make the stitches sewable')
    }
    if (widest > MAX_SPLIT_SATIN_MM) {
      errors.push(
        `the rails are ${widest.toFixed(1)} mm apart at their widest, over the ` +
          `${MAX_SPLIT_SATIN_MM} mm limit even split — use a fill`)
    } else if (widest > MAX_SATIN_MM) {
      warnings.push(
        `the rails reach ${widest.toFixed(1)} mm apart and are only sewable because the column ` +
          'is split; the split line will show under raking light')
    }
  } else if (widest > MAX_SATIN_MM) {
    errors.push(
      `the rails are ${widest.toFixed(1)} mm apart at their widest, over the ${MAX_SATIN_MM} mm ` +
        'limit — use a fill, or turn on satin splitting')
  }
  if (narrowest < MIN_SATIN_MM)
    errors.push(`the rails close to ${narrowest.toFixed(2)} mm, below the ${MIN_SATIN_MM} mm floor — use a bean run, or pull the rails apart`)

  // Crossed rails: the column pinches to nothing and reopens on the other
  // side, so the stitches fold back through themselves.
  const a = dedupe(railA)
  const bRaw = dedupe(railB)
  const b = railsNeedFlip(a, bRaw) ? [...bRaw].reverse() : bRaw
  const wa = railWalk(a, 0.2), wb = railWalk(b, 0.2)
  let prev: { x: number; y: number } | null = null
  for (let i = 0; i <= 32; i++) {
    const u = i / 32
    const pa = atFraction(wa, u), pb = atFraction(wb, u)
    const v = { x: pb.x - pa.x, y: pb.y - pa.y }
    if (prev) {
      // The bar flipping to point the other way means the rails have swapped
      // sides, which only happens where they cross.
      const dot = prev.x * v.x + prev.y * v.y
      if (dot < 0) {
        errors.push('the rails cross — the column folds back through itself; redraw them so they run alongside each other')
        break
      }
    }
    prev = v
  }
  return { errors, warnings }
}

// ---------------------------------------------------------------------------
// 3D puff
// ---------------------------------------------------------------------------

/**
 * Narrowest column that will stand up over foam, mm.
 *
 * Below this the thread simply flattens the foam instead of standing on it —
 * the design sews, it just is not 3D, which is worse than refusing because
 * the operator has already loaded the foam.
 */
export const PUFF_MIN_MM = 3.5

/** Widest column foam supports before it collapses in the middle, mm. */
export const PUFF_MAX_MM = 12

/**
 * Check a column before sewing it over foam.
 *
 * These are WARNINGS, not refusals, and that is deliberate: unlike a column
 * folded through its own centre, a badly-sized puff column still sews. The
 * fault only appears on the garment, so the operator needs telling before
 * they load foam — but they are the one who decides.
 */
export function puffCheck(p: SatinParams, puff: PuffParams): SatinCheck {
  const errors: string[] = []
  const warnings: string[] = []
  const w = p.width + p.pullComp
  if (w < PUFF_MIN_MM) {
    warnings.push(`${w.toFixed(1)} mm is narrow for puff — under about ${PUFF_MIN_MM} mm the thread flattens the foam instead of standing on it`)
  }
  if (w > PUFF_MAX_MM) {
    warnings.push(`${w.toFixed(1)} mm is wide for puff — over about ${PUFF_MAX_MM} mm the foam collapses in the middle`)
  }
  // Foam is thicker than the fabric, so the column has to climb over it: a
  // column barely wider than the foam is tall has nowhere to lie down.
  if (w < puff.thickness * 1.5) {
    warnings.push(`a ${w.toFixed(1)} mm column over ${puff.thickness} mm foam is too steep — use a wider column or thinner foam`)
  }
  if (!puff.capEnds) {
    warnings.push('end capping is off — the excess foam will not tear cleanly at the ends')
  }
  return { errors, warnings }
}

/**
 * Perforate the ends of a puff column so the excess foam tears along the
 * stitching.
 *
 * A very tight zigzag across the column at each end, which is what a
 * digitizer does by hand: the needle punches a dense line of holes, and the
 * foam separates on that line when it is pulled away. Without it the foam
 * tears wherever it feels like, which is the commonest way a puff job is
 * ruined after it has already sewn.
 */
export function puffCaps(path: Pt[], p: SatinParams): Stitch[] {
  const pts = dedupe(path)
  if (pts.length < 2) return []
  const half = (p.width + p.pullComp) / 2
  const closed = isClosed(path)
  // A closed column has no ends to cap — the foam is enclosed by the ring.
  if (closed) return []

  const out: Stitch[] = []
  for (const end of [0, pts.length - 1]) {
    const t = tangentAt(pts, end, false)
    const n = { x: -t.y, y: t.x }
    const c = pts[end]
    // Half the normal satin pitch: this is a perforation, not coverage.
    const step = Math.max(0.2, p.density / 2)
    const count = Math.max(2, Math.ceil((half * 2) / step))
    for (let i = 0; i <= count; i++) {
      const u = -half + (i / count) * half * 2
      out.push({ x: c.x + n.x * u, y: c.y + n.y * u })
    }
  }
  return out
}

export const MAX_SATIN_MM = 10
/** Narrowest satin worth sewing, mm. Below this, use a bean run. */
export const MIN_SATIN_MM = 1.0

export interface SatinCheck {
  /** Refusals: generating anyway would produce unsewable output. */
  errors: string[]
  warnings: string[]
}

/**
 * Check a column BEFORE generating it.
 *
 * These are refusals rather than warnings on purpose. A warning the operator
 * can click past while the engine quietly emits a column folded through its
 * own centre of curvature is worse than no check at all — the first time
 * anyone finds out is a broken needle.
 */
export function satinCheck(path: Pt[], p: SatinParams): SatinCheck {
  const errors: string[] = []
  const warnings: string[] = []
  const w = p.width + p.pullComp
  const half = w / 2
  const pts = dedupe(path)

  // The bar IS the stitch, so width is a stitch length. Splitting puts an
  // extra penetration partway across, which is exactly what makes a wider
  // column sewable — so the limit that applies depends on whether it is on.
  if (p.split?.enabled) {
    if (p.split.maxLength > MAX_SATIN_MM) {
      errors.push(
        `split length ${p.split.maxLength.toFixed(1)} mm is itself over the ${MAX_SATIN_MM} mm ` +
          'limit — splitting there does not make the stitches sewable')
    }
    if (w > MAX_SPLIT_SATIN_MM) {
      errors.push(
        `${w.toFixed(1)} mm column is over the ${MAX_SPLIT_SATIN_MM} mm limit even split — use a fill`)
    } else if (w > MAX_SATIN_MM) {
      warnings.push(
        `${w.toFixed(1)} mm column is only sewable because it is split; the split line will show ` +
          'under raking light — a fill may read better')
    }
  } else if (w > MAX_SATIN_MM) {
    errors.push(
      `${w.toFixed(1)} mm column exceeds the ${MAX_SATIN_MM} mm limit — use a fill, ` +
        'or turn on satin splitting')
  }
  if (w < MIN_SATIN_MM)
    errors.push(`${w.toFixed(2)} mm column is below the ${MIN_SATIN_MM} mm floor — use a bean run`)
  if (pts.length < 2 || pathLength(pts) < p.density * 2) {
    errors.push('path is shorter than a single zigzag')
    return { errors, warnings }
  }

  // Where the spine turns tighter than the column is wide, the inner rail has
  // negative radius: the column crosses itself.
  // Measure curvature on the SMOOTH runs only. Sharp vertices are corners,
  // and corners are mitred rather than swung through, so condemning the
  // column for them would refuse every box, chevron and monogram.
  const corners = findCorners(pts)
  const bounds: [number, number][] = []
  let from = 0
  for (const c of corners) { bounds.push([from, c]); from = c }
  bounds.push([from, pts.length - 1])

  let worst = Infinity
  let at: Pt | null = null
  for (const [a, b] of bounds) {
    const seg = pts.slice(a, b + 1)
    if (seg.length < 3) continue
    const segFine = resample(seg, Math.min(0.15, p.density / 3))
    if (segFine.length < 3) continue
    const segCum = cumulative(segFine)
    // Ignore a half-width of arc at each end: that is the mitre's territory,
    // and the residual turn there is handled by the fan, not by the column.
    const skip = Math.max(0, half)
    const total = segCum[segCum.length - 1]
    for (let i = 1; i < segFine.length - 1; i++) {
      if (segCum[i] < skip || total - segCum[i] < skip) continue
      const k = curvatureAt(segFine, segCum, i, CURV_WINDOW_MM)
      const r = k > 1e-9 ? 1 / k : Infinity
      if (r < worst) { worst = r; at = segFine[i] }
    }
  }
  if (at && worst < half)
    errors.push(
      `turn radius ${worst.toFixed(2)} mm is tighter than the ${half.toFixed(2)} mm half-width at ` +
        `(${at.x.toFixed(1)}, ${at.y.toFixed(1)}) — the column folds through itself`,
    )
  else if (at && worst < half * 2)
    warnings.push(
      `tight turn (radius ${worst.toFixed(2)} mm) at (${at.x.toFixed(1)}, ${at.y.toFixed(1)}) — ` +
        'inner rail will crowd; consider narrowing or splitting',
    )
  return { errors, warnings }
}
