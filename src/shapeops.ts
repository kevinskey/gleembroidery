// Shape operations: the editing a digitizer does to artwork BEFORE deciding
// how it is stitched.
//
// Artwork almost never arrives in the shape the needle needs. A traced logo
// has two overlapping blobs where one object belongs; a letter needs its
// counter knocked out; a badge needs an outline a known distance outside the
// art; an auto-trace arrives with a vertex every half pixel.
//
// Every one of these is a GEOMETRY edit, so they all produce ordinary objects
// the user can go on editing. None of them touches stitch parameters, and
// none of them generates stitches. That separation is what keeps the result
// inspectable: a boolean here is the same kind of thing as dragging a node.
//
// Pure and DOM-free, so the suite covers all of it.

import { booleanPaths, type BoolOp } from './boolean'
import { offsetPathsChecked } from './offset'
import { simplify } from './vector'
import { dist, isClosed, pathLength, segDist } from './geometry'
import { flattenShape, type Shape } from './nodes'
import type { Pt } from './model'

/**
 * Every operation returns this rather than throwing.
 *
 * An operation that cannot be done is not an error in the program, it is an
 * answer about the geometry — and the user needs to be told WHICH geometry
 * and WHY, not handed an empty result that looks like the tool did nothing.
 */
export interface OpResult {
  /** The new geometry, when the operation succeeded. */
  paths: Pt[][]
  /** Why it could not be done. Non-empty means `paths` is not usable. */
  errors: string[]
  warnings: string[]
}

const ok = (paths: Pt[][], warnings: string[] = []): OpResult => ({ paths, errors: [], warnings })
const fail = (...errors: string[]): OpResult => ({ paths: [], errors, warnings: [] })

/** Does this set of paths enclose anything? */
export function hasArea(paths: readonly Pt[][]): boolean {
  return paths.some((p) => p.length >= 3 && isClosed(p))
}

// ---------------------------------------------------------------------------
// Booleans
// ---------------------------------------------------------------------------

export const BOOL_OPS = ['union', 'difference', 'intersection', 'xor'] as const

export const BOOL_LABEL: Record<BoolOp, string> = {
  union: 'Unite',
  difference: 'Subtract',
  intersection: 'Intersect',
  xor: 'Exclude',
}

/**
 * Combine several objects' outlines.
 *
 * ORDER MATTERS and it is the sewing order: operand 0 is the back object, and
 * `difference` subtracts everything in front of it. That matches both what
 * every vector program does and what the sewing sequence already shows, so
 * there is one notion of "in front" in the whole application rather than two.
 *
 * Open paths are REFUSED rather than silently closed. An open path has no
 * inside, so there is no honest answer to "what is inside both of these"; and
 * closing it for the user invents a boundary they did not draw, in the one
 * operation whose entire output is a boundary.
 */
export function booleanOp(op: BoolOp, operands: readonly Pt[][][]): OpResult {
  if (operands.length < 2) return fail('a boolean needs at least two objects')
  const open = operands.filter((o) => !hasArea(o)).length
  if (open) {
    return fail(
      `${open} of the ${operands.length} selected objects ${open === 1 ? 'is' : 'are'} not a ` +
        'closed shape — a boolean works on areas, so close the outline first')
  }
  let out: Pt[][]
  try {
    out = booleanPaths(op, operands as Pt[][][])
  } catch {
    // polygon-clipping throws on near-tangencies, which is the same failure
    // the offset code works around. Nothing useful can be salvaged here, so
    // say so rather than returning a partial shape that looks deliberate.
    return fail(
      `the ${BOOL_LABEL[op].toLowerCase()} could not be computed — the outlines touch almost ` +
        'exactly; nudge one of them slightly and try again')
  }
  if (!out.length) {
    return fail(
      op === 'intersection' ? 'the shapes do not overlap, so there is nothing in common'
        : op === 'difference' ? 'the front shapes cover the back one completely — nothing is left'
        : 'the result has no area')
  }
  return ok(out)
}

/**
 * Remove overlap: each object keeps its own area minus everything sewn AFTER
 * it.
 *
 * This is the operation embroidery needs more than any other, and the reason
 * is physical rather than aesthetic. Two filled objects that overlap are both
 * stitched in full, so the overlap is sewn TWICE: at 0.4 mm spacing that is an
 * effective 0.2 mm, where the needle cuts the stitches already there, the
 * fabric goes stiff, and thread breaks. Knocking the lower object back means
 * only the visible part is sewn, which is what a digitizer does by hand.
 *
 * Done against what is sewn LATER, not earlier, because the later object is
 * the one lying on top — it is the one that will be seen, so it is the one
 * that keeps its full shape.
 */
export function removeOverlap(objects: readonly Pt[][][]): { paths: Pt[][]; errors: string[] }[] {
  return objects.map((paths, i) => {
    if (!hasArea(paths)) {
      // An open path has no area to knock out and none to be knocked out of.
      // Passed through untouched rather than refused: a design is usually a
      // mix, and failing the whole operation because one outline is open
      // would be unhelpful.
      return { paths: paths as Pt[][], errors: [] }
    }
    const above = objects.slice(i + 1).filter(hasArea)
    if (!above.length) return { paths: paths as Pt[][], errors: [] }
    const r = booleanOp('difference', [paths, ...above])
    // Completely covered: that is a real answer, and the object should end up
    // with nothing rather than keeping stitches nobody will see.
    if (r.errors.length) {
      return /completely/.test(r.errors[0])
        ? { paths: [], errors: [] }
        : { paths: paths as Pt[][], errors: r.errors }
    }
    return { paths: r.paths, errors: [] }
  })
}

// ---------------------------------------------------------------------------
// Offset
// ---------------------------------------------------------------------------

/**
 * Grow or shrink an outline by a fixed distance.
 *
 * Used constantly: an outline a known distance outside the art, a knockdown
 * area, a fill inset under an appliqué border so the fill does not peek out.
 *
 * Closed shapes only. Offsetting an open path is a different operation — it
 * produces a band with two sides and two ends, which is a satin column, not
 * an offset outline — and conflating the two would produce a shape nobody
 * asked for from a button labelled something else.
 */
export function offsetOp(paths: readonly Pt[][], delta: number): OpResult {
  if (!hasArea(paths)) {
    return fail('offsetting needs a closed shape — an open path has no inside to grow out of')
  }
  if (Math.abs(delta) < 1e-6) return ok(paths as Pt[][])
  const r = offsetPathsChecked(paths as Pt[][], delta)
  if (r.failed || !r.paths.length) {
    return fail(
      delta < 0
        ? `shrinking by ${Math.abs(delta).toFixed(2)} mm leaves nothing — the shape is narrower than that somewhere`
        : `the outline could not be grown by ${delta.toFixed(2)} mm — it may cross itself`)
  }
  return ok(r.paths)
}

// ---------------------------------------------------------------------------
// Simplify and node cleanup
// ---------------------------------------------------------------------------

/**
 * Default simplification tolerance, mm.
 *
 * Well under a stitch width, so the outline the needle follows is unchanged
 * while the vertex count drops by an order of magnitude on traced artwork.
 */
export const SIMPLIFY_MM = 0.2

/**
 * Thin a polyline, keeping its shape within `tol`.
 *
 * Auto-traced and freehand outlines carry a vertex every half pixel or every
 * mouse move. Those are not detail — they are sampling noise, and they make
 * every parameter change slower and every node edit impossible.
 */
export function simplifyPaths(paths: readonly Pt[][], tol = SIMPLIFY_MM): OpResult {
  const out: Pt[][] = []
  for (const p of paths) {
    const closed = isClosed(p)
    const thin = simplify(p, Math.max(0.001, tol))
    // Never thin a path out of existence: three points is the least that can
    // still enclose anything, and two the least that can be a line.
    if (thin.length >= (closed ? 4 : 2)) out.push(closed ? closeRing(thin) : thin)
    else out.push(p)
  }
  const before = paths.reduce((n, p) => n + p.length, 0)
  const after = out.reduce((n, p) => n + p.length, 0)
  return ok(out, after === before ? ['nothing to remove — the outline is already minimal'] : [])
}

function closeRing(p: Pt[]): Pt[] {
  return isClosed(p) ? p : [...p, { ...p[0] }]
}

/**
 * Clean up the NODES of an editable outline.
 *
 * Different from simplifying the polyline: this works on the Bézier shape, so
 * the curves survive. Two kinds of node are removed — ones closer together
 * than `tol` (duplicates from a double click, or from a trace that was
 * adopted node for node), and ones that sit on a straight line between their
 * neighbours and carry no handles, which add nothing but something to drag by
 * mistake.
 *
 * A node WITH handles is never removed however straight it looks: its handles
 * are what shape the segments either side, and dropping it moves the outline.
 */
export function cleanNodes(shapes: readonly Shape[], tol = 0.05): { shapes: Shape[]; removed: number } {
  let removed = 0
  const out = shapes.map((sh) => {
    const nodes = [...sh.nodes]
    // Duplicates first: a collinearity test on two coincident nodes is
    // meaningless, so the order matters.
    for (let i = nodes.length - 1; i > 0; i--) {
      if (nodes.length <= (sh.closed ? 3 : 2)) break
      if (dist(nodes[i], nodes[i - 1]) < tol && !nodes[i].hIn && !nodes[i].hOut) {
        nodes.splice(i, 1)
        removed++
      }
    }
    for (let i = nodes.length - 2; i > 0; i--) {
      if (nodes.length <= (sh.closed ? 3 : 2)) break
      const n = nodes[i]
      if (n.hIn || n.hOut) continue
      const prev = nodes[i - 1], next = nodes[i + 1]
      if (prev.hOut || next.hIn) continue
      if (segDist(prev, next, n) < tol) {
        nodes.splice(i, 1)
        removed++
      }
    }
    return { ...sh, nodes }
  })
  return { shapes: out, removed }
}

// ---------------------------------------------------------------------------
// Splitting and joining
// ---------------------------------------------------------------------------

/**
 * Cut a shape at a node, giving two open shapes.
 *
 * On a CLOSED shape this opens it at that node, which is one shape, not two —
 * a ring cut once is a line. Two cuts are needed to get two pieces, and the
 * second cut is a second call.
 *
 * The node itself is kept on BOTH sides. Cutting a path should not lose a
 * point, and if the two halves are later rejoined they have to meet
 * somewhere.
 */
export function splitShapeAt(shape: Shape, index: number): { shapes: Shape[]; errors: string[] } {
  const n = shape.nodes.length
  if (index < 0 || index >= n) return { shapes: [shape], errors: ['that node is not on this outline'] }
  if (shape.closed) {
    // Re-walk the ring starting at the cut, so the result is one open path.
    const nodes = [...shape.nodes.slice(index), ...shape.nodes.slice(0, index)]
    nodes.push({ ...shape.nodes[index] })
    return { shapes: [{ closed: false, nodes }], errors: [] }
  }
  if (index === 0 || index === n - 1) {
    return { shapes: [shape], errors: ['cutting at an end would leave one piece with nothing in it'] }
  }
  return {
    shapes: [
      { closed: false, nodes: shape.nodes.slice(0, index + 1).map((q) => ({ ...q })) },
      { closed: false, nodes: shape.nodes.slice(index).map((q) => ({ ...q })) },
    ],
    errors: [],
  }
}

/** How close two ends must be before they count as the same point, mm. */
export const JOIN_TOL_MM = 1.0

/**
 * Join open shapes end to end into as few paths as possible.
 *
 * Imported artwork routinely arrives as a pile of separate segments that look
 * like one outline — every SVG editor produces them, and every one of them
 * becomes its own jump and its own pair of tie stitches if it is left alone.
 *
 * Ends are matched within `tol` and shapes are reversed as needed, because
 * which way a segment was drawn is an accident of the file. A shape whose two
 * ends meet after joining is CLOSED, which is what turns a pile of segments
 * back into something fillable.
 */
export function joinShapes(shapes: readonly Shape[], tol = JOIN_TOL_MM): { shapes: Shape[]; joined: number } {
  const open = shapes.filter((s) => !s.closed && s.nodes.length >= 2).map((s) => ({ ...s, nodes: [...s.nodes] }))
  const closed = shapes.filter((s) => s.closed || s.nodes.length < 2)
  let joined = 0
  let again = true
  while (again) {
    again = false
    outer:
    for (let i = 0; i < open.length; i++) {
      for (let j = i + 1; j < open.length; j++) {
        const a = open[i], b = open[j]
        const aEnd = a.nodes[a.nodes.length - 1], aStart = a.nodes[0]
        const bEnd = b.nodes[b.nodes.length - 1], bStart = b.nodes[0]
        let merged: typeof a.nodes | null = null
        if (dist(aEnd, bStart) <= tol) merged = [...a.nodes, ...b.nodes.slice(1)]
        else if (dist(aEnd, bEnd) <= tol) merged = [...a.nodes, ...[...b.nodes].reverse().slice(1)]
        else if (dist(aStart, bStart) <= tol) merged = [...[...a.nodes].reverse(), ...b.nodes.slice(1)]
        else if (dist(aStart, bEnd) <= tol) merged = [...b.nodes, ...a.nodes.slice(1)]
        if (!merged) continue
        open.splice(j, 1)
        open[i] = { ...a, nodes: merged }
        joined++
        again = true
        break outer
      }
    }
  }
  // A path whose own two ends now meet is a ring.
  const out = open.map((s) => {
    if (s.nodes.length > 3 && dist(s.nodes[0], s.nodes[s.nodes.length - 1]) <= tol) {
      return { closed: true, nodes: s.nodes.slice(0, -1) }
    }
    return s
  })
  return { shapes: [...closed, ...out], joined }
}

/** Flatten shapes back to the polyline cache the stitch engine reads. */
export function shapesToPaths(shapes: readonly Shape[]): Pt[][] {
  return shapes.map((s) => flattenShape(s)).filter((p) => p.length >= 2)
}

/** Total outline length, for reporting what an operation did. */
export function totalLength(paths: readonly Pt[][]): number {
  return paths.reduce((n, p) => n + pathLength(p), 0)
}
