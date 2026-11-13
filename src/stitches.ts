// The flattened stitch plan — what the machine actually does.
//
// Produced by digitize.ts from the document's objects, consumed by the
// renderer and by every file writer. Coordinates stay in mm, Y DOWN, in the
// same space as the document; the writers deal with machine units.

import type { Pt } from './model'

export interface Stitch extends Pt {
  /** Needle up — a travel move, not a penetration. */
  jump?: boolean
  /**
   * Cut the thread before travelling here. DST has no trim opcode, so the
   * writer renders this as a run of jump records, which is what every
   * controller watches for.
   */
  trim?: boolean
  /**
   * Part of a tie-in/tie-off. Locks are deliberately short, so the
   * short-stitch suppressor must leave them alone — absorbing them is exactly
   * how every trim ended up restarting with nothing anchoring the thread.
   */
  lock?: boolean
  /**
   * A penetration added partway across a satin bar to keep it sewable.
   *
   * Marked only so the inspection view can show WHY an extra hole is there;
   * the machine treats it as an ordinary stitch, which is exactly what it is.
   */
  split?: boolean
}

export interface ColorBlock {
  color: string // '#rrggbb'
  label: string
  stitches: Stitch[]
}

export interface StitchPlan {
  blocks: ColorBlock[]
}

export function countStitches(plan: StitchPlan): { stitches: number; jumps: number; colors: number } {
  let stitches = 0, jumps = 0
  for (const b of plan.blocks) for (const s of b.stitches) (s.jump ? jumps++ : stitches++)
  return { stitches, jumps, colors: plan.blocks.length }
}

export function planBounds(plan: StitchPlan) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const b of plan.blocks) for (const s of b.stitches) {
    if (s.x < minX) minX = s.x
    if (s.y < minY) minY = s.y
    if (s.x > maxX) maxX = s.x
    if (s.y > maxY) maxY = s.y
  }
  return isFinite(minX) ? { minX, minY, maxX, maxY, widthMm: maxX - minX, heightMm: maxY - minY } : null
}

/**
 * Longest single SEWN stitch in the plan, mm — a snag/thread-break predictor.
 *
 * Walks the whole plan as one continuous thread path rather than per block:
 * the leg from the end of one colour to the start of the next is a real move
 * the machine makes, and it is exactly where an unjumped connector hides.
 */
export function longestStitch(plan: StitchPlan): number {
  let worst = 0
  let prev: Stitch | null = null
  for (const b of plan.blocks) {
    for (const s of b.stitches) {
      if (prev && !s.jump) worst = Math.max(worst, Math.hypot(s.x - prev.x, s.y - prev.y))
      prev = s
    }
  }
  return worst
}

/** Shortest sewn stitch, mm — repeated penetrations break needles. */
export function shortestStitch(plan: StitchPlan): number {
  let best = Infinity
  let prev: Stitch | null = null
  for (const b of plan.blocks) {
    for (const s of b.stitches) {
      if (prev && !s.jump) {
        best = Math.min(best, Math.hypot(s.x - prev.x, s.y - prev.y))
      }
      prev = s
    }
  }
  return isFinite(best) ? best : 0
}

export function countTrims(plan: StitchPlan): number {
  let n = 0
  for (const b of plan.blocks) for (const s of b.stitches) if (s.trim) n++
  return n
}
