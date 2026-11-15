// Program motifs: French knots, candlewicking and eyelets.
//
// These are named after hand stitches that a machine cannot make. A hand
// French knot wraps thread around the needle and pulls it through its own
// loop; no embroidery head does that. What a machine CAN do is pile thread
// so it stands proud, and anchor it so it stays — which is what these
// generate, and the only honest way to describe them.
//
// The constructions:
//
//   French knot — a star polygon. Every penetration is on the rim of a
//     small circle, each chord crossing near the centre, so thread stacks
//     in the middle and builds a bump while no hole is struck twice.
//     Striking the centre repeatedly is the obvious approach and it is how
//     needles break.
//
//   Candlewicking — the same knot, repeated along a path at a spacing. In
//     hand work candlewicking IS a field of colonial knots; the only thing
//     a machine adds is the travel between them.
//
//   Eyelet — radial bars from an inner rim to an outer rim, all the way
//     round: a satin column bent into a ring. The hole in the middle is
//     real, and the inner rim is where this construction fails if asked for
//     too small a one, because the inner penetrations converge.
//
// Pure and DOM-free.

import type { Pt } from './model'
import type { Stitch } from './stitches'

export type ProgramKind = 'frenchknot' | 'candlewick' | 'eyelet'

export const PROGRAM_KINDS: ProgramKind[] = ['frenchknot', 'candlewick', 'eyelet']

export const PROGRAM_LABEL: Record<ProgramKind, string> = {
  frenchknot: 'French knot — thread piled into a bump',
  candlewick: 'Candlewicking — a field of knots along the path',
  eyelet: 'Eyelet — radial bars around a real hole',
}

export interface ProgramParams {
  kind: ProgramKind
  /** Outside diameter of the knot or eyelet, mm. */
  sizeMm: number
  /** Inner hole diameter for an eyelet, mm. Ignored by the knots. */
  holeMm: number
  /** Chords per knot, or bars per eyelet — how much thread goes in. */
  passes: number
  /** Distance between knots along a candlewicked path, mm. */
  spacingMm: number
}

export const DEFAULT_PROGRAM = (): ProgramParams => ({
  kind: 'frenchknot', sizeMm: 2.5, holeMm: 1.5, passes: 7, spacingMm: 6,
})

/** Below this a knot has no room to pile anything; it reads as a dot. */
export const MIN_KNOT_MM = 1.2

/** An eyelet hole smaller than this closes up as the bars crowd it. */
export const MIN_EYELET_HOLE_MM = 0.8

/** Fewer chords than this is a cross, not a knot. */
export const MIN_PASSES = 3

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)

/**
 * One French knot centred on `c`.
 *
 * A star polygon: n points evenly round the rim, visited in a step that
 * nearly halves the circle each time, so every chord passes close to the
 * centre. With n odd the walk visits every point exactly once and returns
 * to the start — which is why the pass count is forced odd. An even count
 * would close early and leave half the rim unused.
 */
export function frenchKnot(c: Pt, p: ProgramParams): Stitch[] {
  const r = Math.max(MIN_KNOT_MM, p.sizeMm) / 2
  const n0 = Math.max(MIN_PASSES, Math.round(p.passes))
  const n = n0 % 2 === 0 ? n0 + 1 : n0
  const step = (n - 1) / 2 // the star step: as near half the circle as it gets
  const out: Stitch[] = []
  for (let k = 0; k <= n; k++) {
    const idx = (k * step) % n
    const a = (idx / n) * Math.PI * 2
    out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) })
  }
  return out
}

/**
 * Knots along a path at `spacingMm`.
 *
 * The travel between knots is left as ordinary stitching for the caller's
 * travel/trim logic to judge — these are penetrations like any other, and
 * deciding here would duplicate a decision digitize.ts already makes with
 * more context.
 */
export function candlewickRun(path: Pt[], p: ProgramParams): Stitch[] {
  const pts = path.filter((q, i) => i === 0 || dist(q, path[i - 1]) > 1e-9)
  if (pts.length < 2) return pts.length ? frenchKnot(pts[0], p) : []
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]))
  const total = cum[cum.length - 1]
  const gap = Math.max(Math.max(MIN_KNOT_MM, p.sizeMm) * 1.2, p.spacingMm)
  const n = Math.max(1, Math.round(total / gap))
  const out: Stitch[] = []
  for (let k = 0; k <= n; k++) {
    const s = (k / n) * total
    let i = 1
    while (i < cum.length - 1 && cum[i] < s) i++
    const a = pts[i - 1], b = pts[i]
    const seg = cum[i] - cum[i - 1] || 1
    const t = (s - cum[i - 1]) / seg
    out.push(...frenchKnot({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, p))
  }
  return out
}

/**
 * An eyelet centred on `c`: a satin column bent into a ring.
 *
 * Bars alternate outer rim / inner rim, advancing round the circle. The
 * angular step is set by the number of bars, and the OUTER rim is what sets
 * how dense it looks because its circumference is the longer one — the same
 * reasoning as holding satin density on the locally longer rail.
 *
 * The inner rim is where this fails: the smaller the hole, the closer the
 * inner penetrations, until they are one hole and the needle has nowhere to
 * go. eyeletCheck reports that rather than letting it sew.
 */
/**
 * Bars round an eyelet: spacing on the OUTER rim, with the pass count as a
 * floor. Counted from the pass count alone, a 7 mm eyelet got twenty bars —
 * geometrically an eyelet, visually a star. One function so the generator
 * and programCheck cannot disagree about how many there are.
 */
function eyeletBars(outerR: number, innerR: number, passes: number): number {
  // Dense enough on the OUTSIDE to read as a ring...
  const want = Math.max(MIN_PASSES * 2, Math.round(passes * 2), Math.round((2 * Math.PI * outerR) / 0.6))
  // ...but the INNER rim is the binding constraint, and it is the one that
  // breaks needles. Its circumference is the small one, so bars that look
  // comfortable round the outside can land 0.2 mm apart round the hole.
  // Asking for more is asking for a bigger hole, which is what the check says.
  const cap = Math.floor((2 * Math.PI * innerR) / 0.35)
  return Math.max(MIN_PASSES * 2, Math.min(want, Math.max(MIN_PASSES * 2, cap)))
}

export function eyelet(c: Pt, p: ProgramParams): Stitch[] {
  const outer = Math.max(MIN_KNOT_MM, p.sizeMm) / 2
  const inner = Math.min(Math.max(MIN_EYELET_HOLE_MM, p.holeMm) / 2, outer - 0.3)
  // Bars follow the OUTER circumference, with the pass count as a floor.
  // Counting bars from the pass count alone gave a 7 mm eyelet twenty of
  // them — geometrically an eyelet, visually a star, and nothing like the
  // solid ring an eyelet is supposed to be. Spacing round the outside is
  // what decides whether it reads as a ring, exactly as it does for satin.
  const bars = eyeletBars(outer, inner, p.passes)
  const out: Stitch[] = []
  for (let k = 0; k <= bars; k++) {
    const a = (k / bars) * Math.PI * 2
    const r = k % 2 === 0 ? outer : inner
    out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) })
  }
  // No extra closing point: the loop already runs k = 0..bars inclusive, so
  // the last bar lands back on the first outer penetration. Pushing another
  // one there put THREE in a single hole and emitted a zero-length stitch,
  // which the machine-safety gate rejects — correctly.
  return out
}

/**
 * Reasons this program motif will not sew as asked. Empty means it will.
 *
 * Returned as sentences rather than codes because they go straight to the
 * digitizer, and "inner penetrations 0.21 mm apart" is the number that
 * explains what to change.
 */
export function programCheck(p: ProgramParams): string[] {
  const out: string[] = []
  const size = p.sizeMm
  if (size < MIN_KNOT_MM) {
    out.push(`${size.toFixed(1)} mm is below the ${MIN_KNOT_MM} mm floor — there is no room to pile thread`)
  }
  if (p.kind === 'eyelet') {
    const outer = Math.max(MIN_KNOT_MM, size) / 2
    const inner = Math.max(MIN_EYELET_HOLE_MM, p.holeMm) / 2
    if (p.holeMm < MIN_EYELET_HOLE_MM) {
      out.push(`a ${p.holeMm.toFixed(1)} mm hole closes up — ${MIN_EYELET_HOLE_MM} mm is the smallest that stays open`)
    }
    if (inner >= outer - 0.3) {
      out.push(`the hole is too close to the outside: ${(outer * 2).toFixed(1)} mm eyelet needs a hole under ${((outer - 0.3) * 2).toFixed(1)} mm`)
    }
    const bars = eyeletBars(outer, inner, p.passes)
    const asked = Math.max(MIN_PASSES * 2, Math.round(p.passes * 2))
    // The cap is geometry, not a preference — but a request that gets
    // reduced must be SAID, or the control silently stops meaning anything.
    if (bars < asked) {
      out.push(`${asked} bars would crowd the hole; sewing ${bars}. A bigger hole is what buys more bars`)
    }
    const innerPitch = (2 * Math.PI * inner) / bars
    if (innerPitch < 0.3) {
      out.push(`the inner penetrations land ${innerPitch.toFixed(2)} mm apart even at ${bars} bars — the hole is too small for an eyelet this size`)
    }
  }
  if (Math.round(p.passes) < MIN_PASSES) {
    out.push(`${Math.round(p.passes)} passes is a cross, not a knot — ${MIN_PASSES} is the minimum`)
  }
  return out
}

/**
 * Stitches for a program-motif object: one construction per path point for
 * the knots, one per path for an eyelet (its centre is the path's centroid).
 */
export function programStitches(paths: Pt[][], p: ProgramParams): Stitch[] {
  const out: Stitch[] = []
  for (const path of paths) {
    if (!path.length) continue
    if (p.kind === 'candlewick') {
      out.push(...candlewickRun(path, p))
    } else if (p.kind === 'eyelet') {
      // One eyelet per path, centred on the path's own centre — a drawn
      // circle becomes an eyelet where it was drawn, which is what clicking
      // a circle and asking for an eyelet should obviously do.
      let sx = 0, sy = 0
      for (const q of path) { sx += q.x; sy += q.y }
      out.push(...eyelet({ x: sx / path.length, y: sy / path.length }, p))
    } else {
      // A knot at every placed point: the path states where they go.
      for (const q of path) out.push(...frenchKnot(q, p))
    }
  }
  return out
}
