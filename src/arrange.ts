// Align, distribute and mirror.
//
// Housekeeping rather than digitizing, and none the less important for it: a
// row of letters that is nearly on a baseline looks worse than one that is
// obviously not, and nudging eight objects into line by hand is how an
// afternoon disappears.
//
// Everything here returns a per-object TRANSLATION or a transformed path set,
// so the caller applies it the same way a drag does — and therefore carries
// shapes, guides and entry/exit points along with it. None of these functions
// touch an object; they take boxes and paths and hand back geometry.
//
// Pure and DOM-free.

import type { Pt } from './model'

export interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export type AlignEdge = 'left' | 'centreX' | 'right' | 'top' | 'middle' | 'bottom'

export const ALIGN_EDGES: AlignEdge[] = ['left', 'centreX', 'right', 'top', 'middle', 'bottom']

const spanOf = (b: Box, horizontal: boolean) =>
  horizontal ? { lo: b.minX, hi: b.maxX } : { lo: b.minY, hi: b.maxY }

/** Does this edge work along x? */
export function isHorizontal(edge: AlignEdge): boolean {
  return edge === 'left' || edge === 'centreX' || edge === 'right'
}

/**
 * How far each box must move to line up on `edge`.
 *
 * Aligned to the BOUNDS OF THE WHOLE SELECTION, not to the first or last
 * object picked. Aligning to a member makes the result depend on the order
 * things were clicked, which is invisible and therefore surprising; aligning
 * to the group means the same selection always lands the same way.
 *
 * Returns zero deltas for a selection of one, rather than refusing: a single
 * object is already aligned with itself, and an error there would be pedantry.
 */
export function alignDeltas(boxes: readonly Box[], edge: AlignEdge): Pt[] {
  if (boxes.length === 0) return []
  const h = isHorizontal(edge)
  const lo = Math.min(...boxes.map((b) => spanOf(b, h).lo))
  const hi = Math.max(...boxes.map((b) => spanOf(b, h).hi))
  const mid = (lo + hi) / 2
  return boxes.map((b) => {
    const s = spanOf(b, h)
    const d = edge === 'left' || edge === 'top' ? lo - s.lo
      : edge === 'right' || edge === 'bottom' ? hi - s.hi
      : mid - (s.lo + s.hi) / 2
    return h ? { x: d, y: 0 } : { x: 0, y: d }
  })
}

/**
 * How far each box must move for even spacing.
 *
 * Spaced by the GAPS between objects, not by their centres. Centre spacing is
 * the easy implementation and it is wrong whenever the objects are different
 * sizes: three letters of different widths spaced on centres have visibly
 * uneven gaps, which is exactly the fault this is meant to fix.
 *
 * The two outermost objects do not move — they define the run.
 */
export function distributeDeltas(boxes: readonly Box[], horizontal: boolean): Pt[] {
  const n = boxes.length
  const out: Pt[] = boxes.map(() => ({ x: 0, y: 0 }))
  if (n < 3) return out // two objects have one gap; there is nothing to even out
  const order = boxes.map((b, i) => ({ i, s: spanOf(b, horizontal) }))
    .sort((a, b) => a.s.lo - b.s.lo)
  const first = order[0].s, last = order[n - 1].s
  const total = last.hi - first.lo
  const used = order.reduce((sum, o) => sum + (o.s.hi - o.s.lo), 0)
  const gap = (total - used) / (n - 1)
  let cursor = first.lo
  for (let k = 0; k < n; k++) {
    const o = order[k]
    const d = cursor - o.s.lo
    out[o.i] = horizontal ? { x: d, y: 0 } : { x: 0, y: d }
    cursor += (o.s.hi - o.s.lo) + gap
  }
  return out
}

/**
 * Mirror paths about a vertical or horizontal line.
 *
 * About the SELECTION's own centre, so mirroring twice puts everything back
 * exactly where it started. Mirroring about the hoop centre would be a move
 * as well as a flip, and the second press would not undo the first.
 *
 * Note for anyone extending this: a mirrored ring is wound the opposite way.
 * Nothing downstream here cares — toRegions decides inside-ness by nesting
 * and an interior probe rather than by winding — but a future routine that
 * does care must not assume the winding it was given.
 */
export function mirrorPaths(paths: readonly Pt[][], about: number, horizontal: boolean): Pt[][] {
  return paths.map((p) => p.map((q) => horizontal
    ? { x: 2 * about - q.x, y: q.y }
    : { x: q.x, y: 2 * about - q.y }))
}

/** Mirror a single point the same way, for guides and entry/exit markers. */
export function mirrorPt(p: Pt, about: number, horizontal: boolean): Pt {
  return horizontal ? { x: 2 * about - p.x, y: p.y } : { x: p.x, y: 2 * about - p.y }
}

/** The centre of a union box, which is what a mirror flips about. */
export function boxCentreOf(b: Box): Pt {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
}

/**
 * Offset applied to a duplicate so it is visible rather than hidden exactly
 * behind the original, mm.
 *
 * Small on purpose: a duplicate is almost always about to be moved
 * deliberately, and a large jump means undoing the program's guess first.
 */
export const DUPLICATE_OFFSET_MM = 2
