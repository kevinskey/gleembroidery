// Editable outlines: nodes with Bézier handles.
//
// Everything before this stored geometry only as flattened polylines, which is
// what the stitch engine consumes but is useless to edit — once a curve is
// 300 points you can never pull on the curve again, only on its debris.
//
// So an object may now ALSO carry `shapes`: the nodes the user drew. When it
// does, `paths` is a cache re-flattened from them on every edit, and the
// digitizer, DST writer, fill and satin code are untouched — they still see
// the polylines they always saw. That is the whole point of keeping both: the
// editable truth and the sewable derivative, with one direction of flow.
//
// A segment between two nodes is a cubic Bézier when either end has a handle
// facing it, and a straight line when neither does. Straight-line digitizing
// therefore costs nothing: a node with no handles IS a corner point.

import { type Pt } from './model'

export interface PathNode {
  x: number
  y: number
  /** Control point leading INTO this node, absolute mm. */
  hIn?: Pt
  /** Control point leading OUT of this node, absolute mm. */
  hOut?: Pt
  /**
   * A smooth node keeps its two handles collinear, so dragging one swings the
   * other. A corner lets them move independently — that is the difference
   * between the tip of a leaf and the shoulder of a letter.
   */
  smooth?: boolean
}

export interface Shape {
  nodes: PathNode[]
  closed: boolean
}

/** Flattening tolerance, mm. Below the 0.4 mm fill pitch so curves read smooth. */
export const CHORD_MM = 0.25

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)

function bezierPoint(p0: Pt, c0: Pt, c1: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t
  return {
    x: a * p0.x + b * c0.x + c * c1.x + d * p1.x,
    y: a * p0.y + b * c0.y + c * c1.y + d * p1.y,
  }
}

/**
 * How many straight pieces this curve needs to stay inside `tol`.
 *
 * Derived from the control polygon rather than by recursive subdivision: the
 * polygon bounds the curve, so its excess length over the chord is a safe
 * proxy for how far the curve can stray. Cheap, predictable, and it never
 * recurses — this runs on every mousemove while a node is being dragged.
 */
function segmentsFor(p0: Pt, c0: Pt, c1: Pt, p1: Pt, tol: number): number {
  const poly = dist(p0, c0) + dist(c0, c1) + dist(c1, p1)
  const chord = dist(p0, p1)
  const slack = Math.max(0, poly - chord)
  if (slack < 1e-6) return 1
  return Math.max(2, Math.min(240, Math.ceil(Math.sqrt(slack / tol) * 4)))
}

/** Does the segment leaving node i curve, or run straight? */
export function segmentIsCurved(a: PathNode, b: PathNode): boolean {
  return !!(a.hOut || b.hIn)
}

/**
 * Flatten one shape to the polyline the stitch engine wants.
 *
 * A closed shape does NOT repeat its first point here; callers that need the
 * repeat (the object's `paths`) add it, matching what the rest of the codebase
 * already does with rings.
 */
export function flattenShape(shape: Shape, tol = CHORD_MM): Pt[] {
  const { nodes, closed } = shape
  if (nodes.length === 0) return []
  if (nodes.length === 1) return [{ x: nodes[0].x, y: nodes[0].y }]

  const out: Pt[] = [{ x: nodes[0].x, y: nodes[0].y }]
  const last = closed ? nodes.length : nodes.length - 1
  for (let i = 0; i < last; i++) {
    const a = nodes[i]
    const b = nodes[(i + 1) % nodes.length]
    const p0 = { x: a.x, y: a.y }
    const p1 = { x: b.x, y: b.y }
    if (!segmentIsCurved(a, b)) { out.push(p1); continue }
    // A missing handle sits on its own node, which degrades a half-curved
    // segment to the quadratic-looking curve the user actually drew.
    const c0 = a.hOut ?? p0
    const c1 = b.hIn ?? p1
    const n = segmentsFor(p0, c0, c1, p1, tol)
    for (let k = 1; k <= n; k++) out.push(bezierPoint(p0, c0, c1, p1, k / n))
  }
  // Closed shapes come back without the duplicate; the caller closes rings.
  if (closed && out.length > 1) out.pop()
  return out
}

/** Flatten every shape of an object into the `paths` the engine sews. */
export function shapesToPaths(shapes: readonly Shape[], tol = CHORD_MM): Pt[][] {
  return shapes.map((s) => {
    const pts = flattenShape(s, tol)
    return s.closed && pts.length > 2 ? [...pts, { ...pts[0] }] : pts
  })
}

/**
 * Adopt an existing polyline as nodes, so shapes drawn before this existed
 * (or imported from SVG) can still be node-edited.
 *
 * Every node is a corner: the polyline's curvature is already baked into its
 * point density and inventing handles would guess at a shape nobody drew.
 */
export function pathToShape(path: readonly Pt[], closed?: boolean): Shape {
  const pts = path.map((p) => ({ x: p.x, y: p.y }))
  // A ring arrives with its first point repeated; that repeat is structure,
  // not a node, and keeping it would leave a zero-length segment to edit.
  const isRing = pts.length > 2 && dist(pts[0], pts[pts.length - 1]) < 1e-6
  if (isRing) pts.pop()
  return { nodes: pts, closed: closed ?? isRing }
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/** Mirror a smooth node's opposite handle so the two stay collinear. */
export function mirrorHandle(node: PathNode, moved: 'hIn' | 'hOut'): PathNode {
  if (!node.smooth) return node
  const from = node[moved]
  if (!from) return node
  const other = moved === 'hIn' ? 'hOut' : 'hIn'
  const existing = node[other]
  const dx = from.x - node.x, dy = from.y - node.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return node
  // Keep the opposite handle's own LENGTH; only its direction is constrained.
  // Forcing equal lengths too would fight the user every time they shaped one
  // side of a curve.
  const keep = existing ? Math.hypot(existing.x - node.x, existing.y - node.y) : len
  return { ...node, [other]: { x: node.x - (dx / len) * keep, y: node.y - (dy / len) * keep } }
}

/** Move a node, carrying its handles with it. */
export function moveNode(shape: Shape, i: number, to: Pt): Shape {
  const n = shape.nodes[i]
  if (!n) return shape
  const dx = to.x - n.x, dy = to.y - n.y
  const moved: PathNode = {
    ...n, x: to.x, y: to.y,
    hIn: n.hIn && { x: n.hIn.x + dx, y: n.hIn.y + dy },
    hOut: n.hOut && { x: n.hOut.x + dx, y: n.hOut.y + dy },
  }
  const nodes = [...shape.nodes]
  nodes[i] = moved
  return { ...shape, nodes }
}

/** Move one handle, honouring smoothness. */
export function moveHandle(shape: Shape, i: number, which: 'hIn' | 'hOut', to: Pt): Shape {
  const n = shape.nodes[i]
  if (!n) return shape
  const nodes = [...shape.nodes]
  nodes[i] = mirrorHandle({ ...n, [which]: { x: to.x, y: to.y } }, which)
  return { ...shape, nodes }
}

/** Corner <-> smooth. Becoming smooth grows handles along the local run. */
export function toggleSmooth(shape: Shape, i: number): Shape {
  const n = shape.nodes[i]
  if (!n) return shape
  const nodes = [...shape.nodes]
  if (n.smooth) {
    // Back to a corner: keep the handles exactly where they are, just stop
    // constraining them. Deleting them would silently flatten the curve.
    nodes[i] = { ...n, smooth: false }
    return { ...shape, nodes }
  }
  const prev = shape.nodes[(i - 1 + shape.nodes.length) % shape.nodes.length]
  const next = shape.nodes[(i + 1) % shape.nodes.length]
  const dx = (next?.x ?? n.x) - (prev?.x ?? n.x)
  const dy = (next?.y ?? n.y) - (prev?.y ?? n.y)
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) { nodes[i] = { ...n, smooth: true }; return { ...shape, nodes } }
  const k = len / 6 // a third of the way to each neighbour, halved per side
  nodes[i] = {
    ...n, smooth: true,
    hIn: { x: n.x - (dx / len) * k, y: n.y - (dy / len) * k },
    hOut: { x: n.x + (dx / len) * k, y: n.y + (dy / len) * k },
  }
  return { ...shape, nodes }
}

/**
 * Add a node on the segment leaving `i`, at parameter `t`.
 *
 * A curved segment is split with de Casteljau, which is EXACT — the outline
 * does not move at all, which is the only acceptable behaviour when the user
 * asked to add a point, not to reshape. A straight segment just interpolates.
 */
export function insertNode(shape: Shape, i: number, t = 0.5): Shape {
  const a = shape.nodes[i]
  const b = shape.nodes[(i + 1) % shape.nodes.length]
  if (!a || !b) return shape
  const nodes = [...shape.nodes]
  if (!segmentIsCurved(a, b)) {
    const mid = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    nodes.splice(i + 1, 0, mid)
    return { ...shape, nodes }
  }
  const p0 = { x: a.x, y: a.y }, p1 = { x: b.x, y: b.y }
  const c0 = a.hOut ?? p0, c1 = b.hIn ?? p1
  const lerp = (p: Pt, q: Pt) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
  const q0 = lerp(p0, c0), q1 = lerp(c0, c1), q2 = lerp(c1, p1)
  const r0 = lerp(q0, q1), r1 = lerp(q1, q2)
  const mid = lerp(r0, r1)
  nodes[i] = { ...a, hOut: q0 }
  nodes[(i + 1) % nodes.length] = { ...b, hIn: q2 }
  nodes.splice(i + 1, 0, { x: mid.x, y: mid.y, hIn: r0, hOut: r1, smooth: true })
  return { ...shape, nodes }
}

/**
 * Remove a node. An open path needs two, a closed one needs three — fewer is
 * not a shape, so the delete is refused rather than leaving a husk behind.
 */
export function deleteNode(shape: Shape, i: number): Shape {
  const min = shape.closed ? 3 : 2
  if (shape.nodes.length <= min) return shape
  const nodes = shape.nodes.filter((_, k) => k !== i)
  return { ...shape, nodes }
}

/** Every handle currently on show, for hit-testing and drawing. */
export function handlesOf(shape: Shape): { i: number; which: 'hIn' | 'hOut'; at: Pt }[] {
  const out: { i: number; which: 'hIn' | 'hOut'; at: Pt }[] = []
  shape.nodes.forEach((n, i) => {
    if (n.hIn) out.push({ i, which: 'hIn', at: n.hIn })
    if (n.hOut) out.push({ i, which: 'hOut', at: n.hOut })
  })
  return out
}

/**
 * The segment nearest a point, and how far along it the point falls.
 *
 * Walked SEGMENT BY SEGMENT rather than over the whole flattened outline,
 * because the caller needs the node index to insert at — and recovering that
 * from a position in one long polyline means tracking where each segment
 * started, which is the same work with more places to get it wrong.
 */
export function nearestSegment(
  shape: Shape, p: Pt, tol: number, flatten = CHORD_MM,
): { i: number; t: number; dist: number } | null {
  const { nodes, closed } = shape
  if (nodes.length < 2) return null
  let best: { i: number; t: number; dist: number } | null = null
  const last = closed ? nodes.length : nodes.length - 1
  for (let i = 0; i < last; i++) {
    const a = nodes[i]
    const b = nodes[(i + 1) % nodes.length]
    const pts = flattenShape({ nodes: [a, b], closed: false }, flatten)
    // Parameter is approximated by position along the flattened piece, which
    // is what the user sees, and is exact enough to split where they clicked.
    let acc = 0
    const lengths: number[] = [0]
    for (let k = 1; k < pts.length; k++) { acc += dist(pts[k - 1], pts[k]); lengths.push(acc) }
    for (let k = 1; k < pts.length; k++) {
      const A = pts[k - 1], B = pts[k]
      const dx = B.x - A.x, dy = B.y - A.y
      const L = dx * dx + dy * dy
      const u = L ? Math.max(0, Math.min(1, ((p.x - A.x) * dx + (p.y - A.y) * dy) / L)) : 0
      const d = Math.hypot(p.x - (A.x + u * dx), p.y - (A.y + u * dy))
      if (d <= tol && (!best || d < best.dist)) {
        const along = lengths[k - 1] + u * (lengths[k] - lengths[k - 1])
        best = { i, t: acc > 1e-9 ? along / acc : 0, dist: d }
      }
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Arcs
// ---------------------------------------------------------------------------

/**
 * A circular arc through three points, as Bézier nodes.
 *
 * Three points is the digitiser's way of drawing an arc — start, end, and a
 * point it must pass through — because it needs no centre, no angles and no
 * direction convention. Collinear points have no circle, so they come back as
 * the straight line they are rather than as a failure.
 */
export function arcThrough(a: Pt, through: Pt, b: Pt): Shape {
  const straight: Shape = { nodes: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }], closed: false }
  const d = 2 * (a.x * (through.y - b.y) + through.x * (b.y - a.y) + b.x * (a.y - through.y))
  if (Math.abs(d) < 1e-9) return straight
  const ua = a.x * a.x + a.y * a.y, ut = through.x * through.x + through.y * through.y
  const ub = b.x * b.x + b.y * b.y
  const cx = (ua * (through.y - b.y) + ut * (b.y - a.y) + ub * (a.y - through.y)) / d
  const cy = (ua * (b.x - through.x) + ut * (a.x - b.x) + ub * (through.x - a.x)) / d
  const c = { x: cx, y: cy }
  const r = dist(c, a)
  if (!isFinite(r) || r < 1e-9 || r > 1e6) return straight

  const ang = (p: Pt) => Math.atan2(p.y - cy, p.x - cx)
  const a0 = ang(a), at = ang(through), a1 = ang(b)
  // Sweep the way that actually passes through the middle point.
  const norm = (x: number) => ((x % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
  let sweep = norm(a1 - a0)
  if (norm(at - a0) > sweep) sweep -= Math.PI * 2

  // One cubic per quarter turn keeps the Bézier error negligible.
  const count = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)))
  const step = sweep / count
  const k = (4 / 3) * Math.tan(step / 4)
  const nodes: PathNode[] = []
  for (let i = 0; i <= count; i++) {
    const th = a0 + step * i
    const p = { x: cx + r * Math.cos(th), y: cy + r * Math.sin(th) }
    const tangent = { x: -Math.sin(th) * r, y: Math.cos(th) * r }
    const node: PathNode = { x: p.x, y: p.y, smooth: true }
    if (i > 0) node.hIn = { x: p.x - tangent.x * k, y: p.y - tangent.y * k }
    if (i < count) node.hOut = { x: p.x + tangent.x * k, y: p.y + tangent.y * k }
    nodes.push(node)
  }
  return { nodes, closed: false }
}
