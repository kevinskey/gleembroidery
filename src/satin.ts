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

import type { Pt, RunParams, SatinParams } from './model'
import type { Stitch } from './stitches'
import { dedupe, dist, isClosed, pathLength, resample, tangentAt } from './geometry'

/** Hard floor on same-rail penetration spacing, mm. Below this is one hole. */
export const MIN_RAIL_MM = 0.3

/** Arc length over which curvature is measured, mm. */
const CURV_WINDOW_MM = 0.6

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
function smoothColumn(pts: Pt[], p: SatinParams, closed: boolean, startSide: number):
  { stitches: Stitch[]; side: number } {
  const half = (p.width + p.pullComp) / 2
  const density = Math.max(0.1, p.density)
  const fine = resample(pts, Math.min(0.15, density / 3))
  if (fine.length < 2) return { stitches: [], side: startSide }
  const cum = cumulative(fine)

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

    out.push({ x: fine[i].x + n.x * half * side, y: fine[i].y + n.y * half * side })
    side = -side
  }

  // Land the far end squarely rather than wherever the rhythm happened to be.
  const last = fine[fine.length - 1]
  const tl = tangentAt(fine, fine.length - 1, closed)
  const nl = { x: -tl.y, y: tl.x }
  const tail = { x: last.x + nl.x * half * side, y: last.y + nl.y * half * side }
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
export function satinColumn(path: Pt[], p: SatinParams): Stitch[] {
  const pts = dedupe(path)
  if (pts.length < 2) return []
  if ((p.width + p.pullComp) / 2 <= 0) return []
  const closed = isClosed(path)

  const corners = findCorners(pts)
  if (!corners.length) return smoothColumn(pts, p, closed, 1).stitches

  const out: Stitch[] = []
  let side = 1
  let from = 0
  for (const c of corners) {
    const seg = pts.slice(from, c + 1)
    if (seg.length >= 2) {
      const r = smoothColumn(seg, p, false, side)
      out.push(...r.stitches)
      side = r.side
    }
    const f = cornerFan(pts, c, p, side)
    out.push(...f.stitches)
    side = f.side
    from = c
  }
  const tailSeg = pts.slice(from)
  if (tailSeg.length >= 2) out.push(...smoothColumn(tailSeg, p, false, side).stitches)
  return out
}

/** Satin's underlay options, all laid on the spine before the column. */
export function satinUnderlay(path: Pt[], p: SatinParams): Stitch[] {
  const pts = dedupe(path)
  if (pts.length < 2) return []
  switch (p.underlay) {
    case 'none':
      return []
    case 'center':
      // A plain run down the middle gives the column something to sit on.
      return resample(pts, 2.0)
    case 'edge': {
      // Runs just inside each rail, there and back.
      const inset = Math.max(0.2, (p.width + p.pullComp) / 2 - 0.4)
      const closed = isClosed(path)
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
        underlay: 'none',
      })
  }
}

/** Widest satin that will not snag in wear, mm. Past this, use a fill. */
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

  if (w > MAX_SATIN_MM)
    errors.push(`${w.toFixed(1)} mm column exceeds the ${MAX_SATIN_MM} mm limit — use a fill, or split the column`)
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
