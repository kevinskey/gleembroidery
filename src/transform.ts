// Selecting, moving and resizing objects on the canvas.
//
// Pure and DOM-free so the headless suite covers it; App.tsx owns the pointer
// plumbing and render.ts draws the handles. Units are mm, Y DOWN.

import { isClosed, pointInPoly } from './geometry'
import { bounds, type EmbObject, type Pt } from './model'
import { distToPaths } from './vector'

export interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** The eight drag handles, named by compass point. */
export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
export type Handle = (typeof HANDLES)[number]

/**
 * Smallest an object may be squashed to, mm.
 *
 * Zero would let a drag collapse a shape to a line it can never be pulled back
 * out of — the scale factor to recover from a zero extent does not exist. This
 * also keeps the resize from inverting: the moving edge stops at the anchor
 * rather than crossing it.
 */
export const MIN_SIZE_MM = 0.5

export function objectBox(obj: EmbObject): Box | null {
  return bounds(obj.paths)
}

/** Box around several objects, for a multi-selection or just one. */
export function unionBox(boxes: readonly (Box | null)[]): Box | null {
  let out: Box | null = null
  for (const b of boxes) {
    if (!b) continue
    out = out
      ? {
        minX: Math.min(out.minX, b.minX), minY: Math.min(out.minY, b.minY),
        maxX: Math.max(out.maxX, b.maxX), maxY: Math.max(out.maxY, b.maxY),
      }
      : b
  }
  return out
}

/** Where each handle sits on a box. */
export function handlePoint(b: Box, h: Handle): Pt {
  const midX = (b.minX + b.maxX) / 2
  const midY = (b.minY + b.maxY) / 2
  const x = h.includes('w') ? b.minX : h.includes('e') ? b.maxX : midX
  const y = h.startsWith('n') ? b.minY : h.startsWith('s') ? b.maxY : midY
  return { x, y }
}

/**
 * Which handle is under the pointer, if any.
 *
 * `tol` comes from the caller in mm, converted from a constant screen radius,
 * so handles stay the same size to grab at every zoom level. Corners are
 * tested first: at a tight zoom a corner overlaps both its edge handles, and
 * the corner is what the user is aiming at.
 */
export function hitHandle(b: Box, p: Pt, tol: number): Handle | null {
  const corners = HANDLES.filter((h) => h.length === 2)
  const edges = HANDLES.filter((h) => h.length === 1)
  for (const h of [...corners, ...edges]) {
    const q = handlePoint(b, h)
    if (Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol) return h
  }
  return null
}

/**
 * Is the pointer on this object?
 *
 * Near the outline always counts. Inside counts too when the shape is closed,
 * so a filled badge can be grabbed from the middle — but an open line can only
 * be grabbed by the line itself, since "inside" means nothing for it.
 *
 * Rings are counted even-odd, so clicking through the hole in a letter 'O'
 * does NOT grab the O. That matches what the fill engine does with the same
 * geometry, which is the only answer that will not surprise anyone.
 */
export function hitObject(obj: EmbObject, p: Pt, tol: number): boolean {
  if (!obj.visible || !obj.paths.length) return false
  if (distToPaths(obj.paths, p) <= tol) return true
  const closed = obj.paths.some((ring) => ring.length > 3 && isClosed(ring))
  if (!closed) return false
  let inside = false
  for (const ring of obj.paths) if (pointInPoly(ring, p)) inside = !inside
  return inside
}

/** Topmost object under the pointer — later objects draw over earlier ones. */
export function pickObject(objs: readonly EmbObject[], p: Pt, tol: number): EmbObject | null {
  for (let i = objs.length - 1; i >= 0; i--) if (hitObject(objs[i], p, tol)) return objs[i]
  return null
}

export function movePaths(paths: Pt[][], dx: number, dy: number): Pt[][] {
  return paths.map((ring) => ring.map((q) => ({ x: q.x + dx, y: q.y + dy })))
}

/**
 * The box a drag produces, given which handle is being pulled.
 *
 * The opposite side stays put — dragging 'se' pins 'nw' — which is what makes
 * a resize feel anchored rather than slippery. `keepAspect` (Shift) applies
 * only to corner handles: an edge handle is a one-axis operation by
 * definition, and quietly moving the other axis would be a lie.
 */
export function resizeBox(from: Box, h: Handle, p: Pt, keepAspect = false): Box {
  const to: Box = { ...from }
  if (h.includes('w')) to.minX = Math.min(p.x, from.maxX - MIN_SIZE_MM)
  if (h.includes('e')) to.maxX = Math.max(p.x, from.minX + MIN_SIZE_MM)
  if (h.startsWith('n')) to.minY = Math.min(p.y, from.maxY - MIN_SIZE_MM)
  if (h.startsWith('s')) to.maxY = Math.max(p.y, from.minY + MIN_SIZE_MM)

  if (keepAspect && h.length === 2) {
    const w0 = Math.max(from.maxX - from.minX, 1e-9)
    const h0 = Math.max(from.maxY - from.minY, 1e-9)
    // Follow whichever axis the user pulled further, so the shape tracks the
    // cursor instead of lagging on the smaller of the two.
    const k = Math.max((to.maxX - to.minX) / w0, (to.maxY - to.minY) / h0)
    const w = Math.max(w0 * k, MIN_SIZE_MM)
    const hh = Math.max(h0 * k, MIN_SIZE_MM)
    if (h.includes('w')) to.minX = to.maxX - w; else to.maxX = to.minX + w
    if (h.startsWith('n')) to.minY = to.maxY - hh; else to.maxY = to.minY + hh
  }
  return to
}

/**
 * Map geometry from one box onto another.
 *
 * A zero extent is left ALONE rather than scaled: a perfectly horizontal line
 * has no height, and the factor that would stretch it is a division by zero.
 * Such a path is translated onto the new box instead, which is the only
 * meaningful thing to do with it.
 */
export function fitPaths(paths: Pt[][], from: Box, to: Box): Pt[][] {
  const w0 = from.maxX - from.minX
  const h0 = from.maxY - from.minY
  const sx = w0 > 1e-9 ? (to.maxX - to.minX) / w0 : 1
  const sy = h0 > 1e-9 ? (to.maxY - to.minY) / h0 : 1
  return paths.map((ring) => ring.map((q) => ({
    x: to.minX + (w0 > 1e-9 ? (q.x - from.minX) * sx : q.x - from.minX),
    y: to.minY + (h0 > 1e-9 ? (q.y - from.minY) * sy : q.y - from.minY),
  })))
}

/**
 * Rotate geometry about a centre.
 *
 * Rotation does NOT go through the bounding box the way move and resize do.
 * An axis-aligned box cannot represent a rotated shape — deriving the new
 * geometry from a rotated box would re-flatten it to axis-aligned and shear
 * the design. The points are transformed directly instead.
 */
export function rotatePaths(paths: Pt[][], c: Pt, rad: number): Pt[][] {
  const cos = Math.cos(rad), sin = Math.sin(rad)
  return paths.map((ring) => ring.map((q) => {
    const dx = q.x - c.x, dy = q.y - c.y
    return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
  }))
}

/** Centre of a box — the pivot a rotation turns about. */
export function boxCentre(b: Box): Pt {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
}

/**
 * Angle from the pivot to the pointer, with an optional snap.
 *
 * Snapping is to ABSOLUTE angles rather than to increments of the drag, so
 * 15 degrees means 15 degrees from where the shape started — which is what
 * someone squaring a design up actually wants.
 */
export function rotationAngle(c: Pt, from: Pt, to: Pt, snapDeg = 0): number {
  const a0 = Math.atan2(from.y - c.y, from.x - c.x)
  const a1 = Math.atan2(to.y - c.y, to.x - c.x)
  let d = a1 - a0
  if (snapDeg > 0) {
    const step = (snapDeg * Math.PI) / 180
    d = Math.round(d / step) * step
  }
  return d
}

/** The mouse cursor each handle should show. */
export function handleCursor(h: Handle): string {
  if (h === 'n' || h === 's') return 'ns-resize'
  if (h === 'e' || h === 'w') return 'ew-resize'
  if (h === 'nw' || h === 'se') return 'nwse-resize'
  return 'nesw-resize'
}
