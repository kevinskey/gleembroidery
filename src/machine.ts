// The step between a stitch plan and a machine file.
//
// Every format below this point wants the same thing in a different wrapper:
// a list of absolute needle positions in machine units, with the commands
// between them. Doing that conversion once, here, is what keeps three
// encoders from each inventing their own slightly different idea of when a
// trim happens or where the design starts.
//
// MACHINE UNITS ARE 0.1 MM AND +Y IS UP. The document is millimetres with +Y
// down. The flip happens once, here and in the DST writer, and nowhere else.
//
// Pure and DOM-free.

import type { StitchPlan } from './stitches'

export type MoveKind =
  /** Needle down — a penetration. */
  | 'stitch'
  /** Needle up, thread still attached. */
  | 'jump'
  /** Cut the thread, then travel here needle-up. */
  | 'trim'
  /** Stop for a thread change. The position is where the next block starts. */
  | 'color'

export interface Move {
  kind: MoveKind
  /** Absolute position, 0.1 mm machine units, +Y UP. */
  x: number
  y: number
}

/**
 * Flatten a plan into machine moves.
 *
 * Three things are decided here rather than per format, because getting any
 * of them different between two exports of the same design would mean the
 * files sew differently:
 *
 *   THE APPROACH is needle-up. The needle starts at the hoop centre, nowhere
 *   near the first penetration, and sewing that leg drags a thread straight
 *   across the garment.
 *
 *   A COLOUR CHANGE sits between blocks and carries the position of the next
 *   block's first stitch, because that is where the machine must be when it
 *   resumes.
 *
 *   A TRIM is its own command. DST has no trim opcode and has to fake one
 *   with a run of jumps; EXP and JEF both have a real one, and using it is
 *   the difference between asking for a cut and hoping a controller infers
 *   it from a pattern of moves.
 */
export function planToMoves(plan: StitchPlan): Move[] {
  const out: Move[] = []
  let first = true
  plan.blocks.forEach((block, bi) => {
    if (!block.stitches.length) return
    const at = (s: { x: number; y: number }) => ({
      x: Math.round(s.x * 10),
      y: Math.round(-s.y * 10), // document +Y down -> machine +Y up
    })
    if (bi > 0 && out.length) {
      out.push({ kind: 'color', ...at(block.stitches[0]) })
    }
    for (const s of block.stitches) {
      const p = at(s)
      if (first) {
        // Reaching the design at all is a needle-up move.
        out.push({ kind: 'jump', ...p })
        first = false
        continue
      }
      if (s.trim) { out.push({ kind: 'trim', ...p }); continue }
      out.push({ kind: s.jump ? 'jump' : 'stitch', ...p })
    }
  })
  return out
}

/**
 * Split a move into hops no longer than `max` on either axis.
 *
 * Both EXP and JEF carry their deltas as SIGNED BYTES, so ±127 is the whole
 * reachable range per record. A design with a 20 mm travel in it is not
 * unusual, and a writer that simply truncated the delta would put the needle
 * somewhere else and every stitch after it would be wrong by the same amount.
 *
 * Interpolated from the position the move STARTED at, not from the running
 * one: stepping from the running position accumulates each rounding and the
 * last hop lands short.
 */
export function splitMove(
  fromX: number, fromY: number, toX: number, toY: number, max: number,
): { x: number; y: number }[] {
  const dx = toX - fromX, dy = toY - fromY
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / max))
  const out: { x: number; y: number }[] = []
  for (let i = 1; i <= steps; i++) {
    out.push({
      x: Math.round(fromX + (dx * i) / steps),
      y: Math.round(fromY + (dy * i) / steps),
    })
  }
  return out
}

/** Extents of a move list in machine units. */
export function moveBounds(moves: readonly Move[]): {
  minX: number; minY: number; maxX: number; maxY: number
} {
  let minX = 0, minY = 0, maxX = 0, maxY = 0
  for (const m of moves) {
    if (m.x < minX) minX = m.x
    if (m.x > maxX) maxX = m.x
    if (m.y < minY) minY = m.y
    if (m.y > maxY) maxY = m.y
  }
  return { minX, minY, maxX, maxY }
}

/** Distinct colours in a plan, in sewing order. */
export function planColors(plan: StitchPlan): string[] {
  return plan.blocks.filter((b) => b.stitches.length).map((b) => b.color)
}
