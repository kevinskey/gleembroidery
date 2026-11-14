// Auto-scroll: how fast the view should follow a pointer at the edge.
//
// Zoomed in far enough to place nodes accurately, the shape being traced is
// bigger than the window, so a pen path runs into the edge and stops. Every
// digitizing program answers this the same way: during a gesture, a pointer
// near the edge drags the view with it.
//
// The arithmetic lives here rather than in the component because it is where
// the mistakes are — a margin measured from the wrong side, a speed that
// never reaches zero and leaves the view drifting, a direction that flips
// when the pointer leaves the window entirely. All of that is testable; the
// rest of the feature is a requestAnimationFrame loop that is not.
//
// Pure and DOM-free.

export interface EdgeRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface EdgeVelocity {
  /** Pixels per second. Positive is right / down. */
  vx: number
  vy: number
}

/** How deep a margin triggers it, in px. */
export const EDGE_PX = 56
/** Top speed, px/second, at the very edge of the canvas. */
export const EDGE_SPEED = 900

/**
 * Speed from depth into the margin.
 *
 * Squared rather than linear so easing into the margin nudges the view gently
 * and pressing right up to the edge moves it fast: a constant speed is either
 * too slow to cross a big design or too fast to stop where you meant to.
 *
 * Clamped at the margin's full depth, so a pointer dragged well outside the
 * window travels at the same speed as one held at the edge rather than
 * accelerating away.
 */
function speed(depth: number, margin: number, max: number): number {
  if (depth <= 0) return 0
  const t = Math.min(1, depth / margin)
  return t * t * max
}

/**
 * How fast to pan, given where the pointer is against the canvas.
 *
 * Returns zeroes when the pointer is in the comfortable middle, which is what
 * tells the caller to stop the loop entirely rather than keep running at
 * zero speed.
 */
export function edgeVelocity(
  rect: EdgeRect,
  x: number,
  y: number,
  margin = EDGE_PX,
  max = EDGE_SPEED,
): EdgeVelocity {
  // Each axis is handled independently, so a corner pans diagonally — which
  // is what a path heading into a corner needs.
  let vx = 0
  let vy = 0
  if (x < rect.left + margin) vx = -speed(rect.left + margin - x, margin, max)
  else if (x > rect.right - margin) vx = speed(x - (rect.right - margin), margin, max)
  if (y < rect.top + margin) vy = -speed(rect.top + margin - y, margin, max)
  else if (y > rect.bottom - margin) vy = speed(y - (rect.bottom - margin), margin, max)
  return { vx, vy }
}

/**
 * How far the view's centre moves this frame, in document mm.
 *
 * Divided by the scale so the view travels at the same ON-SCREEN speed at
 * every zoom: a fixed millimetre step would be a crawl at 20× and a lurch at
 * 0.5×, and the speed that matters is the one the eye is tracking.
 */
export function panStep(v: EdgeVelocity, dtSeconds: number, scale: number): { dx: number; dy: number } {
  return { dx: (v.vx * dtSeconds) / scale, dy: (v.vy * dtSeconds) / scale }
}
