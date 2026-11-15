// Manual stitch: the digitizer places every needle penetration.
//
// Everything else in this app DERIVES stitches from an outline. This is the
// one type where the points ARE the stitches, and that difference drives
// every decision here:
//
//   * The NODES are read, not the flattened path. Flattening a curve would
//     invent penetrations between the ones that were placed, which is the
//     opposite of what the tool is for. A manual object's nodes are corners.
//   * Nothing is resampled. A 7 mm stitch next to a 1 mm one is a choice,
//     not an error to be smoothed away.
//   * The machine limits still apply, because they are the machine's and not
//     ours — but where the safety pass will CHANGE what was placed, the
//     digitizer is told, rather than finding out from the sewout. That is
//     the whole difference between this and a generated object: here, a
//     silent correction is a correction to someone's deliberate work.
//
// Pure and DOM-free. Editing (place / move / insert / delete) is the node
// machinery in nodes.ts — a manual object is nodes, so it gets all four for
// free and they stay tested in one place.

import type { EmbObject, Pt } from './model'
import type { Stitch } from './stitches'

/** Two penetrations closer than this strike one hole and risk the needle. */
export const MANUAL_MIN_MM = 0.5

/** Longer than this cannot be sewn and will be subdivided downstream. */
export const MANUAL_MAX_MM = 10

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)

/**
 * The penetrations of a manual object, in order.
 *
 * Reads `shapes` when present — those are the placed nodes. Falls back to
 * the flattened `paths` for objects that arrived some other way (an import
 * converted to manual, say), where the path points are all there is.
 */
export function manualPenetrations(obj: EmbObject): Pt[] {
  const shape = obj.shapes?.[0]
  if (shape?.nodes?.length) {
    const pts = shape.nodes.map((n) => ({ x: n.x, y: n.y }))
    // A closed manual outline returns to its first penetration; an open one
    // simply stops. Repeating the point would strike the same hole twice.
    return shape.closed && pts.length > 2 ? [...pts, pts[0]] : pts
  }
  return obj.paths[0] ? [...obj.paths[0]] : []
}

export interface ManualReport {
  stitches: Stitch[]
  /** Placed stitches the machine cannot sew as given. */
  tooLong: number
  /** Placed penetrations that fall in a neighbour's hole. */
  tooClose: number
}

/**
 * Turn placed points into stitches, and report what the machine will have to
 * change about them.
 *
 * The stitches come back UNMODIFIED — subdividing and dropping is the job of
 * enforceMaxStitch / suppressShortStitches, which every object goes through
 * and which must stay the single place those rules live. What this adds is
 * the count, so the caller can say so out loud.
 */
export function manualStitches(
  pts: Pt[], min = MANUAL_MIN_MM, max = MANUAL_MAX_MM,
): ManualReport {
  const stitches: Stitch[] = pts.map((p) => ({ x: p.x, y: p.y }))
  let tooLong = 0, tooClose = 0
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i])
    if (d > max) tooLong++
    else if (d < min) tooClose++
  }
  return { stitches, tooLong, tooClose }
}

/**
 * What to tell the digitizer about an object whose points the machine will
 * not sew as placed. Empty when everything is sewable as given.
 */
export function manualWarnings(name: string, r: ManualReport): string[] {
  const out: string[] = []
  if (r.tooLong > 0) {
    out.push(`${name}: ${r.tooLong} placed stitch${r.tooLong === 1 ? '' : 'es'} over ${MANUAL_MAX_MM} mm — ` +
      `extra penetrations will be added to sew ${r.tooLong === 1 ? 'it' : 'them'}`)
  }
  if (r.tooClose > 0) {
    out.push(`${name}: ${r.tooClose} placed penetration${r.tooClose === 1 ? '' : 's'} under ${MANUAL_MIN_MM} mm ` +
      `from ${r.tooClose === 1 ? 'its' : 'their'} neighbour — dropped, to keep the needle out of one hole twice`)
  }
  return out
}
