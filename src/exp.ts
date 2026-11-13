// Melco EXP — write.
//
// The simplest machine format there is: no header, no thread table, no
// extents, no stitch count. The whole file is a stream of moves, and
// everything a reader knows about the design it works out by accumulating
// them. That makes it the easiest format to get RIGHT, and also the easiest
// to get silently wrong, because there is no self-describing field anywhere
// to disagree with the data.
//
// RECORD ENCODING
//   dx dy                 a normal stitch, signed bytes, 0.1 mm units
//   0x80 0x04 dx dy       jump (needle up)
//   0x80 0x01 0x00 0x00   colour change
//   0x80 0x80 0x07 0x00   trim
//
// +Y IS UP, like every machine format; the document is +Y down and the flip
// happens in machine.ts.
//
// Deltas are SIGNED BYTES, so a move is limited to ±127 units (12.7 mm) per
// record. Longer moves are split — not truncated, which would leave the
// needle somewhere else and every stitch after it wrong by the same amount.

import type { StitchPlan } from './stitches'
import { planToMoves, splitMove } from './machine'

/** Largest move one EXP record can express, in 0.1 mm units. */
export const EXP_MAX_STEP = 127

export function writeExp(plan: StitchPlan): Uint8Array {
  const out: number[] = []
  let curX = 0, curY = 0

  // The delta written is the MACHINE-frame one. planToMoves has already
  // turned the document's +Y-down into the machine's +Y-up; negating again
  // here wrote every design upside down, which round-tripped through our own
  // reader perfectly and was caught only by pyembroidery.
  const byte = (v: number) => v & 0xff
  const stitchTo = (x: number, y: number) => {
    out.push(byte(x - curX), byte(y - curY))
    curX = x; curY = y
  }
  const jumpTo = (x: number, y: number) => {
    out.push(0x80, 0x04, byte(x - curX), byte(y - curY))
    curX = x; curY = y
  }

  for (const m of planToMoves(plan)) {
    switch (m.kind) {
      case 'stitch':
        // A normal stitch should never need splitting — digitize caps sewn
        // stitches at 10 mm — but if one ever did, splitting it keeps the
        // needle where the plan says it is. Each piece is still a stitch:
        // turning the tail into a jump would leave a gap in the stitching.
        for (const p of splitMove(curX, curY, m.x, m.y, EXP_MAX_STEP)) stitchTo(p.x, p.y)
        break
      case 'jump':
        for (const p of splitMove(curX, curY, m.x, m.y, EXP_MAX_STEP)) jumpTo(p.x, p.y)
        break
      case 'trim':
        // The cut happens where the needle IS, then it travels. Travelling
        // first and cutting on arrival would drag the thread that is about
        // to be cut across the whole gap.
        out.push(0x80, 0x80, 0x07, 0x00)
        for (const p of splitMove(curX, curY, m.x, m.y, EXP_MAX_STEP)) jumpTo(p.x, p.y)
        break
      case 'color':
        // The colour change carries no movement of its own; the machine
        // stops where it is and the travel to the next block follows.
        out.push(0x80, 0x01, 0x00, 0x00)
        for (const p of splitMove(curX, curY, m.x, m.y, EXP_MAX_STEP)) jumpTo(p.x, p.y)
        break
    }
  }
  // EXP has no end marker: the file ends when the bytes do. Writing one
  // would be inventing a record the format does not define, and readers that
  // did not expect it would take it as a stitch.
  return Uint8Array.from(out)
}
