// Freestanding lace: a mesh that has to hold itself together once the
// water-soluble backing is washed away.
//
// This is the one stitch type in the program where a correct-looking preview
// is actively dangerous. Every other fill is supported by fabric; this one is
// the fabric. If the threads do not cross and lock into each other, the
// design looks perfect on screen, sews perfectly, and falls apart in the
// sink. So the mesh is generated AND judged, and the judgement is not a
// formality — see laceCheck.
//
// What is generated: two sets of parallel lines crossing at an angle, each
// line sewn with several passes so the thread at a crossing is thick enough
// to grip, and a reinforced border that every line terminates into. The
// border is not decoration. It is what the mesh hangs from.
//
// Pure and DOM-free.

import type { Pt, Region } from './model'
import type { Stitch } from './stitches'
import { scanlineSpans } from './geometry'

export type LacePattern = 'grid' | 'diamond' | 'hex'

export const LACE_PATTERNS: LacePattern[] = ['grid', 'diamond', 'hex']

export const LACE_PATTERN_LABEL: Record<LacePattern, string> = {
  grid: 'Grid — lines at 90°, the simplest net',
  diamond: 'Diamond — lines at 60°, more crossings per area',
  hex: 'Hex — three directions, strongest for its weight',
}

export interface LaceParams {
  pattern: LacePattern
  /** Gap between neighbouring threads of one direction, mm. */
  spacingMm: number
  /** Rotation of the whole mesh, degrees. */
  angle: number
  /** Passes along each mesh thread. One pass is a single thread: too thin. */
  passes: number
  /** Passes round the border the mesh hangs from. */
  borderPasses: number
}

export const DEFAULT_LACE = (): LaceParams => ({
  pattern: 'diamond', spacingMm: 2.5, angle: 0, passes: 3, borderPasses: 4,
})

/**
 * Widest gap that still holds, mm.
 *
 * Beyond this the cells are large enough to distort under their own weight
 * and the lace goes limp. It is a rule of thumb from the trade rather than a
 * measured constant, which is why exceeding it WARNS rather than refuses.
 */
export const LACE_MAX_SPACING_MM = 4

/** Below this the mesh is so dense it is really a fill, not lace. */
export const LACE_MIN_SPACING_MM = 1

/** Fewer passes than this and a mesh thread is one strand with nothing to grip. */
export const LACE_MIN_PASSES = 2

/** A lace piece smaller than this has no span to hold open. */
export const LACE_MIN_SPAN_MM = 8

const rot = (p: Pt, c: number, s: number): Pt => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c })

function regionBounds(region: Region) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const ring of region) for (const p of ring) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  return { minX, minY, maxX, maxY }
}

/**
 * Lines of the mesh in one direction, clipped to the shape.
 *
 * Returned as segments rather than stitched so the caller can decide how to
 * order and reinforce them — a mesh thread that is sewn once and travelled
 * away from is a mesh thread that unravels.
 */
function meshLines(region: Region, deg: number, spacing: number): Pt[][] {
  const rad = (deg * Math.PI) / 180
  const c = Math.cos(-rad), s = Math.sin(-rad)
  const ic = Math.cos(rad), is = Math.sin(rad)
  const rotated: Region = region.map((ring) => ring.map((p) => rot(p, c, s)))
  const { minY, maxY } = regionBounds(rotated)
  const out: Pt[][] = []
  // Anchored to the ORIGIN like the cross-stitch grid, so two lace panels
  // meeting at a seam share one mesh instead of two that nearly line up.
  const start = Math.floor(minY / spacing) * spacing
  for (let y = start; y <= maxY; y += spacing) {
    for (const [x0, x1] of scanlineSpans(rotated, y)) {
      if (x1 - x0 < 0.5) continue // a sliver at a tip is not a mesh thread
      out.push([rot({ x: x0, y }, ic, is), rot({ x: x1, y }, ic, is)])
    }
  }
  return out
}

/** A segment sewn back and forth `passes` times, ending where it is useful. */
function reinforced(seg: Pt[], passes: number): Stitch[] {
  const n = Math.max(1, Math.round(passes))
  const out: Stitch[] = [seg[0]]
  for (let k = 0; k < n; k++) out.push(k % 2 === 0 ? seg[1] : seg[0])
  return out
}

/**
 * Reasons this will not survive the wash. Empty does NOT mean it will —
 * no geometric check can promise that, and the caller is expected to say so.
 */
export function laceCheck(region: Region, p: LaceParams): string[] {
  const out: string[] = []
  const { minX, minY, maxX, maxY } = regionBounds(region)
  const span = Math.min(maxX - minX, maxY - minY)
  if (!isFinite(span) || span < LACE_MIN_SPAN_MM) {
    out.push(`${isFinite(span) ? span.toFixed(1) : '0'} mm across is too small to hold itself open — ${LACE_MIN_SPAN_MM} mm is the floor`)
  }
  if (p.spacingMm > LACE_MAX_SPACING_MM) {
    out.push(`${p.spacingMm.toFixed(1)} mm cells go limp once the backing washes out — ${LACE_MAX_SPACING_MM} mm is about the limit`)
  }
  if (p.spacingMm < LACE_MIN_SPACING_MM) {
    out.push(`${p.spacingMm.toFixed(1)} mm is dense enough to be a fill, not lace`)
  }
  if (Math.round(p.passes) < LACE_MIN_PASSES) {
    out.push(`one pass leaves each mesh thread a single strand with nothing to grip at a crossing — ${LACE_MIN_PASSES} is the minimum`)
  }
  if (Math.round(p.borderPasses) < LACE_MIN_PASSES) {
    out.push('the border is what the whole mesh hangs from; it needs more than one pass')
  }
  // A mesh thread that crosses nothing is a loose end. Count the shortest
  // direction's span against the spacing: fewer than three threads across
  // means there is barely a lattice at all.
  const threads = Math.floor(span / Math.max(0.1, p.spacingMm))
  if (threads < 3) {
    out.push(`only ${threads} mesh thread(s) fit across the narrow direction — there is no lattice to lock together`)
  }
  return out
}

/**
 * The mesh for one region, plus the border it hangs from.
 *
 * Order matters here in a way it does not for a fill: the border goes LAST,
 * over the ends of every mesh thread, so the ends are trapped under it. A
 * border sewn first leaves every thread end on top, anchored by nothing.
 */
export function laceStitches(region: Region, p: LaceParams): Stitch[] {
  if (!region.length || region[0].length < 3) return []
  const spacing = Math.max(0.3, p.spacingMm)
  const angles = p.pattern === 'grid' ? [p.angle, p.angle + 90]
    : p.pattern === 'diamond' ? [p.angle + 60, p.angle - 60]
      : [p.angle, p.angle + 60, p.angle + 120]

  const out: Stitch[] = []
  let prev: Pt | null = null
  for (const a of angles) {
    const lines = meshLines(region, a, spacing)
    // Serpentine: take each line from the end nearest the last one, so the
    // travel between threads is short and stays inside the piece.
    let flip = false
    for (const seg of lines) {
      const ordered = flip ? [seg[1], seg[0]] : seg
      const st = reinforced(ordered, p.passes)
      if (prev) {
        const d = Math.hypot(st[0].x - prev.x, st[0].y - prev.y)
        if (d > spacing * 2.5) out.push({ ...st[0], jump: true })
      }
      out.push(...st)
      prev = out[out.length - 1]
      flip = !flip
    }
  }

  // The border, last, over every thread end.
  for (const ring of region) {
    if (ring.length < 3) continue
    const closed = [...ring, ring[0]]
    const n = Math.max(1, Math.round(p.borderPasses))
    if (prev) out.push({ ...closed[0], jump: true })
    for (let k = 0; k < n; k++) {
      const path = k % 2 === 0 ? closed : [...closed].reverse()
      out.push(...path.map((q) => ({ x: q.x, y: q.y })))
    }
    prev = out[out.length - 1]
  }
  return out
}
