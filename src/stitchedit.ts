// Direct stitch editing, and the rule that keeps it safe.
//
// Everywhere else in this program stitches are DERIVED: change an object and
// the plan is regenerated from it. Editing stitches directly breaks that, and
// the danger is obvious — the next regeneration would wipe the edits without
// anyone noticing.
//
// THE FREEZE MODEL. The moment a stitch is edited by hand, the plan is
// FROZEN: it stops being derived and becomes the document's own data,
// recorded with the source signature it was taken from. From then on:
//
//   • the frozen plan is what is shown, counted, simulated and exported —
//     one plan, as everywhere else, so nothing can disagree;
//   • editing a source object does NOT silently regenerate. The signature no
//     longer matches, the document says so, and the user chooses: discard the
//     manual edits and go back to generating, or keep them and accept that
//     the source edit has not been applied.
//
// There is deliberately no third option where both happen. Re-running
// generation and then replaying manual edits onto a different stitch list is
// the version that looks clever and silently corrupts designs: stitch 412 of
// the new plan is not the stitch that was moved.
//
// Pure and DOM-free.

import type { Stitch, StitchPlan } from './stitches'
import type { Pt } from './model'

export interface FrozenPlan {
  plan: StitchPlan
  /** The source signature this plan was generated from, before editing. */
  signature: string
  /** How many manual operations have been applied, for the user's sake. */
  edits: number
}

/** A stitch's position in the plan: which block, and which stitch in it. */
export interface StitchRef {
  block: number
  index: number
}

export type FreezeState =
  /** No manual edits; the plan is generated as normal. */
  | { kind: 'live' }
  /** Manual edits, and the source still matches what they were made on. */
  | { kind: 'frozen'; edits: number }
  /** Manual edits, and the source has since changed. Needs a decision. */
  | { kind: 'stale'; edits: number }

export function freezeState(frozen: FrozenPlan | undefined, signature: string): FreezeState {
  if (!frozen) return { kind: 'live' }
  return frozen.signature === signature
    ? { kind: 'frozen', edits: frozen.edits }
    : { kind: 'stale', edits: frozen.edits }
}

/** Deep-copy a plan so edits cannot reach back into the generated one. */
export function clonePlan(plan: StitchPlan): StitchPlan {
  return {
    blocks: plan.blocks.map((b) => ({
      ...b,
      stitches: b.stitches.map((s) => ({ ...s })),
    })),
  }
}

/** Take a generated plan under manual control. */
export function freeze(plan: StitchPlan, signature: string): FrozenPlan {
  return { plan: clonePlan(plan), signature, edits: 0 }
}

/**
 * The stitch nearest a point, within `tol`.
 *
 * Jumps are skipped: they are travel, not stitches, and there is nothing
 * useful to do to one directly — the way to remove a jump is to fix the
 * object order that caused it.
 */
export function pickStitch(plan: StitchPlan, p: Pt, tol: number): StitchRef | null {
  let best: StitchRef | null = null
  let bestD = tol
  plan.blocks.forEach((b, bi) => {
    b.stitches.forEach((s, si) => {
      if (s.jump) return
      const d = Math.hypot(s.x - p.x, s.y - p.y)
      if (d <= bestD) { bestD = d; best = { block: bi, index: si } }
    })
  })
  return best
}

/** Every stitch inside a box, for selecting a range by dragging over it. */
export function pickStitchesIn(
  plan: StitchPlan, box: { minX: number; minY: number; maxX: number; maxY: number },
): StitchRef[] {
  const out: StitchRef[] = []
  plan.blocks.forEach((b, bi) => {
    b.stitches.forEach((s, si) => {
      if (s.jump) return
      if (s.x >= box.minX && s.x <= box.maxX && s.y >= box.minY && s.y <= box.maxY) {
        out.push({ block: bi, index: si })
      }
    })
  })
  return out
}

const key = (r: StitchRef) => `${r.block}:${r.index}`

/**
 * Delete stitches.
 *
 * Removed back to front within each block, so the indices of the stitches
 * still to be removed are not shifted by the ones already gone — the classic
 * way a multi-delete removes the wrong things.
 *
 * A block emptied completely is dropped: a colour block with no stitches is a
 * thread change for nothing, and the DST writer would emit a stop for it.
 */
export function deleteStitches(plan: StitchPlan, refs: readonly StitchRef[]): StitchPlan {
  const byBlock = new Map<number, number[]>()
  for (const r of refs) {
    const list = byBlock.get(r.block)
    if (list) list.push(r.index); else byBlock.set(r.block, [r.index])
  }
  const blocks = plan.blocks.map((b, bi) => {
    const idx = byBlock.get(bi)
    if (!idx) return b
    const stitches = b.stitches.slice()
    for (const i of [...idx].sort((a, c) => c - a)) stitches.splice(i, 1)
    return { ...b, stitches }
  }).filter((b) => b.stitches.length > 0)
  return { blocks }
}

/** Move stitches by a delta. */
export function moveStitches(
  plan: StitchPlan, refs: readonly StitchRef[], dx: number, dy: number,
): StitchPlan {
  const set = new Set(refs.map(key))
  return {
    blocks: plan.blocks.map((b, bi) => ({
      ...b,
      stitches: b.stitches.map((s, si) =>
        set.has(`${bi}:${si}`) ? { ...s, x: s.x + dx, y: s.y + dy } : s),
    })),
  }
}

export function stitchAt(plan: StitchPlan, r: StitchRef): Stitch | null {
  return plan.blocks[r.block]?.stitches[r.index] ?? null
}

/** Total non-jump stitches, for reporting what an edit changed. */
export function penetrationCount(plan: StitchPlan): number {
  let n = 0
  for (const b of plan.blocks) for (const s of b.stitches) if (!s.jump) n++
  return n
}
