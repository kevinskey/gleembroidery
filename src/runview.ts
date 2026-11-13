// The sewing sequence as the machine will run it.
//
// The panel used to be a flat list of objects — twenty-six rows reading
// "Traced 7  FILL  ↑ ↓ ●" — which is the DOCUMENT's structure, not the
// run's. Nothing on screen answered the question an operator actually has,
// which is "how many times do I re-thread, and with what".
//
// A machine does not see objects. It sees COLOUR BLOCKS: a run of stitching
// on one needle, then a stop, then the next. Objects that share a thread and
// sit next to each other in the sequence are one block and cost one
// threading; the same objects separated by something else are two blocks and
// cost two. That relationship is invisible in a flat list and obvious in a
// grouped one, and it is the single most useful thing the panel can show —
// it is what turns "26 objects" into "you will re-thread 26 times on a
// 12-needle machine", which is a fact about the afternoon.
//
// Blocks are DERIVED, never stored. The document is still an ordered list of
// objects; this is a reading of it. Move an object and the blocks re-form.
//
// Pure and DOM-free.

import type { Doc, EmbObject } from './model'
import { objectVisible } from './model'
import type { StitchPlan } from './stitches'

export interface RunObject {
  object: EmbObject
  /** Its position in the document, which is what reordering moves. */
  index: number
}

export interface RunBlock {
  /** 1-based, and the order the operator works in. */
  number: number
  color: string
  /** The thread assigned to it, or null when nobody has chosen one yet. */
  thread: { brand?: string; code?: string; name?: string } | null
  objects: RunObject[]
  /** Needle penetrations, from the generated plan. Null when not generated. */
  stitches: number | null
  /**
   * An appliqué phase sews as its own block and MUST NOT be merged with a
   * neighbour on the same thread: the block boundary is the machine stop the
   * operator is waiting at. Shown as its own row so the stop is visible.
   */
  isStop: boolean
}

/**
 * What decides whether two objects share a needle: the assigned thread if
 * there is one, otherwise the screen colour.
 *
 * The same rule digitize.ts uses, and it has to stay the same rule. Keying
 * the panel on colour while the engine keys on thread would show one block
 * where the machine does two, which is exactly the kind of disagreement that
 * is only discovered at the machine.
 */
export function needleKey(o: EmbObject): string {
  const assigned = [o.thread.brand, o.thread.code].filter(Boolean).join(' ').trim()
  return assigned ? `t:${assigned.toLowerCase()}` : `c:${o.color.toLowerCase()}`
}

/**
 * Group the document into the blocks the machine will sew.
 *
 * `plan` is optional: without it the blocks are still right, they just have
 * no stitch counts. That matters because the panel has to be usable while
 * generation is still running.
 */
export function runBlocks(doc: Doc, plan?: StitchPlan | null): RunBlock[] {
  const out: RunBlock[] = []
  let planIndex = 0

  doc.objects.forEach((object, index) => {
    const sewn = objectVisible(object, doc.groups) && object.type !== 'none'
    const last = out[out.length - 1]
    // Appliqué is a SEQUENCE of phases with machine stops between them, so it
    // never joins the block before it and nothing joins it.
    const isStop = object.type === 'applique'
    const joins = !isStop
      && !!last
      && !last.isStop
      && sewn
      && last.objects.some((q) => objectVisible(q.object, doc.groups) && q.object.type !== 'none')
      && needleKey(last.objects[0].object) === needleKey(object)

    if (joins && last) {
      last.objects.push({ object, index })
      return
    }
    const assigned = object.thread.brand || object.thread.code || object.thread.name
      ? { ...object.thread } : null
    out.push({
      number: 0, // filled in below, once the unsewn ones are known
      color: object.color,
      thread: assigned,
      objects: [{ object, index }],
      stitches: null,
      isStop,
    })
  })

  // Number only the blocks that actually sew, so the numbers are needle
  // order rather than row order — a hidden object must not take a number
  // the operator will then look for and not find.
  let n = 0
  for (const b of out) {
    const sews = b.objects.some((q) =>
      objectVisible(q.object, doc.groups) && q.object.type !== 'none')
    b.number = sews ? ++n : 0
  }

  // Stitch counts, matched positionally against the generated plan. The
  // engine emits its blocks in the same order for the same reasons, so the
  // nth sewing block here is the nth block there; if generation has not run
  // or disagrees, the counts are simply absent rather than wrong.
  if (plan) {
    for (const b of out) {
      if (!b.number) continue
      const pb = plan.blocks[planIndex++]
      b.stitches = pb ? pb.stitches.filter((s) => !s.jump).length : null
    }
  }
  return out
}

/** How many times the operator re-threads. */
export function threadChanges(blocks: readonly RunBlock[]): number {
  return blocks.filter((b) => b.number > 0).length
}

/** Blocks with no thread chosen — the run sheet will say UNASSIGNED. */
export function unassignedBlocks(blocks: readonly RunBlock[]): RunBlock[] {
  return blocks.filter((b) => b.number > 0 && !b.thread)
}

/**
 * Move an object to a new position in the document order.
 *
 * Expressed as "put the object at `from` immediately before the object
 * currently at `to`", which is what a drag actually means, and is the
 * version that does not go wrong when dragging downward — the naive
 * splice-out-then-splice-in lands one short, because removing the object
 * shifts everything after it.
 */
export function reorder<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return [...items]
  const out = [...items]
  const [moved] = out.splice(from, 1)
  out.splice(from < to ? to - 1 : to, 0, moved)
  return out
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * A plain name for a colour.
 *
 * "Traced 7" tells you nothing; "Red 7" tells you which of the twenty-six
 * rows to look at. Deliberately a short list of ordinary words rather than a
 * thread chart: this is a label for a list, and nobody needs "Burnt Sienna"
 * to find a row.
 */
const NAMED: [string, number, number, number][] = [
  ['Black', 0, 0, 0],
  ['White', 255, 255, 255],
  ['Grey', 128, 128, 128],
  ['Red', 220, 40, 40],
  ['Orange', 240, 140, 30],
  ['Yellow', 240, 220, 60],
  ['Green', 60, 170, 70],
  ['Teal', 40, 170, 170],
  ['Blue', 50, 100, 220],
  ['Navy', 20, 35, 90],
  ['Purple', 140, 70, 200],
  ['Pink', 230, 90, 150],
  ['Brown', 130, 85, 50],
  ['Cream', 240, 230, 200],
]

export function colourName(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) return 'Colour'
  const v = parseInt(m[1], 16)
  const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff
  let best = NAMED[0], bestD = Infinity
  for (const c of NAMED) {
    // Weighted toward green, which is where the eye resolves most detail —
    // the usual cheap approximation, and far better here than plain RGB
    // distance, which calls mid-blue and mid-brown neighbours.
    const d = 2 * (c[1] - r) ** 2 + 4 * (c[2] - g) ** 2 + 3 * (c[3] - b) ** 2
    if (d < bestD) { bestD = d; best = c }
  }
  return best[0]
}
