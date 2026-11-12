// Drawing tools: build vector geometry from pointer input.
//
// Kevin asked for "simple shapes + freehand" (2026-11-12) rather than a
// pen/bézier tool — the fast path for lettering backdrops, badges and simple
// marks. Everything here is PURE and DOM-free so it is covered by the headless
// suite; App.tsx owns the pointer plumbing and the canvas.
//
// Units are mm, Y DOWN, matching model.ts. Rings come back OPEN (no repeated
// first point) because that is what the rest of the pipeline hands around;
// geometry.close() applies the repeat when an object is built.

import type { Pt } from './model'
import { simplify } from './vector'
import { dedupe, pathLength } from './geometry'

/**
 * Smallest drag that counts as a shape, mm.
 *
 * A click that moves two pixels is a click, not a rectangle. Without this a
 * stray press leaves degenerate objects all over the sewing sequence, and a
 * zero-area region makes the fill engine do nothing in a way that reads as a
 * bug rather than as an accident.
 */
export const MIN_DRAW_MM = 1

/** How close a freehand end must come to its start to be read as closed, mm. */
export const FREEHAND_CLOSE_MM = 2.5

/** Chord tolerance when flattening curves, mm. Below the 0.4 mm fill pitch. */
const CHORD_MM = 0.3

/**
 * Axis-aligned rectangle spanning two drag corners.
 *
 * `square` keeps the LARGER extent and grows in the direction of the drag, so
 * the corner under the cursor stays the corner the user is pulling — shrinking
 * to the smaller extent instead makes the shape jump away from the pointer.
 */
export function rectPath(a: Pt, b: Pt, square = false): Pt[] {
  let dx = b.x - a.x
  let dy = b.y - a.y
  if (square) {
    const s = Math.max(Math.abs(dx), Math.abs(dy))
    dx = Math.sign(dx || 1) * s
    dy = Math.sign(dy || 1) * s
  }
  const x0 = a.x, y0 = a.y, x1 = a.x + dx, y1 = a.y + dy
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ]
}

/**
 * Ellipse inscribed in the drag box, flattened to a polygon.
 *
 * Segment count follows the PERIMETER rather than being fixed: a 4 mm dot and
 * a 200 mm oval need very different numbers of points to stay under the chord
 * tolerance, and a fixed count makes one of them either lumpy or wasteful.
 */
export function ellipsePath(a: Pt, b: Pt, circle = false): Pt[] {
  let rx = Math.abs(b.x - a.x) / 2
  let ry = Math.abs(b.y - a.y) / 2
  if (circle) { const r = Math.max(rx, ry); rx = r; ry = r }
  const cx = circle ? a.x + Math.sign(b.x - a.x || 1) * rx : (a.x + b.x) / 2
  const cy = circle ? a.y + Math.sign(b.y - a.y || 1) * ry : (a.y + b.y) / 2

  // Ramanujan's perimeter approximation — plenty for picking a step count.
  const h = ((rx - ry) ** 2) / ((rx + ry) ** 2 || 1)
  const perim = Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)))
  const n = Math.max(32, Math.min(512, Math.ceil(perim / CHORD_MM)))

  const pts: Pt[] = []
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2
    pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) })
  }
  return pts
}

/** Is this drag big enough to be a shape rather than a slipped click? */
export function bigEnough(a: Pt, b: Pt): boolean {
  return Math.abs(b.x - a.x) >= MIN_DRAW_MM || Math.abs(b.y - a.y) >= MIN_DRAW_MM
}

/**
 * Turn a raw pointer trail into a usable path.
 *
 * Raw trails carry one point per mouse event — hundreds of nearly collinear
 * points that would each become a needle penetration. Simplification is not
 * cosmetic here: it is the difference between a smooth run and a stitch file
 * that stutters.
 *
 * A trail whose end lands back near its start is reported closed, so drawing a
 * loop gives a fillable region instead of an open line the fill engine cannot
 * use.
 */
export function freehandPath(raw: readonly Pt[], tol = CHORD_MM): { path: Pt[]; closed: boolean } {
  const pts = dedupe(raw.map((p) => ({ x: p.x, y: p.y })), 0.05)
  if (pts.length < 2) return { path: [], closed: false }

  const first = pts[0]
  const last = pts[pts.length - 1]
  const gap = Math.hypot(last.x - first.x, last.y - first.y)
  // Only a trail with some length can be a loop; a 3 mm scribble has its ends
  // close together by arithmetic, not by intent.
  const closed = gap <= FREEHAND_CLOSE_MM && pathLength(pts) > FREEHAND_CLOSE_MM * 4

  let path = simplify(pts, tol)
  if (closed) {
    // Drop the returning tail so the ring does not double back on itself, and
    // let the object's own closure join the ends.
    if (path.length > 3) path = path.slice(0, -1)
    if (path.length < 3) return { path: [], closed: false }
  }
  if (path.length < 2) return { path: [], closed: false }
  return { path, closed }
}

/** Is a polygon in progress worth committing? */
export function polygonUsable(pts: readonly Pt[]): boolean {
  return pts.length >= 3
}
