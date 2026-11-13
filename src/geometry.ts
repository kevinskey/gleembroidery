// Path maths shared by every stitch generator.
// Pure functions, no DOM — so the engine runs under node for the test suite.

import type { Pt } from './model'

export const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)

/** Below this, two points are the same point. One micron. */
export const GEOM_EPS_MM = 1e-3

export function pathLength(pts: Pt[]): number {
  let L = 0
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i])
  return L
}

export function isClosed(pts: Pt[], tol = 1e-6): boolean {
  return pts.length > 2 && dist(pts[0], pts[pts.length - 1]) <= tol
}

export function close(pts: Pt[]): Pt[] {
  return isClosed(pts) ? pts : [...pts, { ...pts[0] }]
}

export function ringArea(ring: Pt[]): number {
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/** Distance from p to the SEGMENT ab — not to the infinite line through it. */
export function segDist(a: Pt, b: Pt, p: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 > 1e-12
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
    : 0
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

export function pointInPoly(poly: Pt[], p: Pt): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/**
 * Walk a polyline placing a point every `step` mm.
 *
 * This is the needle-penetration generator for run stitches and the spine of
 * a satin column, so it is EXACT about the ends: the first and last points of
 * the input always survive. The interior spacing is shrunk to the largest
 * value <= step that divides the length evenly, which avoids the stubby
 * leftover stitch a naive walk leaves at the end of every path.
 */
export function resample(pts: Pt[], step: number): Pt[] {
  const clean = dedupe(pts)
  if (clean.length < 2) return clean
  const total = pathLength(clean)
  if (total <= 1e-9) return [clean[0]]
  const n = Math.max(1, Math.round(total / step))
  const d = total / n
  const out: Pt[] = [clean[0]]
  let seg = 1
  let walked = 0 // distance along the path at clean[seg-1]
  for (let i = 1; i < n; i++) {
    const target = i * d
    while (seg < clean.length - 1 && walked + dist(clean[seg - 1], clean[seg]) < target) {
      walked += dist(clean[seg - 1], clean[seg])
      seg++
    }
    const a = clean[seg - 1], b = clean[seg]
    const segLen = dist(a, b) || 1
    const t = Math.min(1, Math.max(0, (target - walked) / segLen))
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
  }
  out.push(clean[clean.length - 1])
  return out
}

export function dedupe(pts: Pt[], tol = 1e-7): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (!last || dist(last, p) > tol) out.push(p)
  }
  return out
}

/** Unit tangent at index i of a polyline, averaging the two adjacent edges. */
export function tangentAt(pts: Pt[], i: number, closed: boolean): Pt {
  const n = pts.length
  const prev = closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)]
  const next = closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)]
  const dx = next.x - prev.x, dy = next.y - prev.y
  const L = Math.hypot(dx, dy) || 1
  return { x: dx / L, y: dy / L }
}

export function rotatePt(p: Pt, cos: number, sin: number): Pt {
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }
}

/**
 * Split the rings of a path set into regions: one outer ring plus the rings
 * nested directly inside it. Rings at even containment depth start a new
 * region; odd-depth rings become holes of the smallest ring enclosing them.
 * This is what makes a filled 'O' keep its counter.
 */
/**
 * A point guaranteed to be strictly INSIDE a ring.
 *
 * Nesting used to be decided by testing `ring[0]`, which is whatever vertex
 * the SVG subpath happened to start at. A crossing-number test is undefined
 * for a point lying on an edge, so a counter touching its outer boundary —
 * a notch, a keyhole, the bowl of a P — classified as a separate shape and
 * got FILLED SOLID. Worse, it depended on vertex order: rotating the same
 * vertex list changed the answer.
 *
 * Instead, take a scanline midway between two distinct vertex heights and
 * return the midpoint of its first span. That point is interior by
 * construction, whatever order the vertices arrived in.
 */
export function interiorPoint(ring: Pt[]): Pt {
  const ys = [...new Set(ring.map((p) => p.y))].sort((a, b) => a - b)
  for (let i = 0; i + 1 < ys.length; i++) {
    const y = (ys[i] + ys[i + 1]) / 2
    const xs: number[] = []
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length]
      if (a.y > y === b.y > y) continue
      xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x))
    }
    xs.sort((p, q) => p - q)
    for (let k = 0; k + 1 < xs.length; k += 2)
      if (xs[k + 1] - xs[k] > 1e-9) return { x: (xs[k] + xs[k + 1]) / 2, y }
  }
  return ring[0] // degenerate ring; nothing better to offer
}

/**
 * Is ring `a` nested inside ring `b`?
 *
 * NOT "is a's interior point inside b". That test fails on the commonest
 * shape in embroidery — a frame. The outer ring of a 40x30 box with a 34x24
 * window has its interior point at the centre, which lies inside the WINDOW,
 * so the outline classified as a hole and every offset ran backwards.
 *
 * Instead, sample points ON ring a (its vertices and its edge midpoints) and
 * take a majority verdict. A boundary point is unambiguous with respect to a
 * ring that does not touch it, and the majority absorbs the few samples that
 * land exactly on b's edge where they do.
 */
export function ringInsideRing(a: Pt[], b: Pt[]): boolean {
  let inside = 0, tested = 0
  const step = Math.max(1, Math.floor(a.length / 24)) // cap the work on dense rings
  for (let i = 0; i < a.length; i += step) {
    const p = a[i], q = a[(i + 1) % a.length]
    for (const probe of [p, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }]) {
      tested++
      if (pointInPoly(b, probe)) inside++
    }
  }
  return tested > 0 && inside * 2 > tested
}

export function toRegions(paths: Pt[][]): Pt[][][] {
  const rings = paths
    .map((p) => {
      // A micron is far below anything a needle can resolve, and well below
      // the sampling epsilon the SVG flattener uses — but a 0.001 mm closing
      // gap left as a real edge gives the offsetter a degenerate segment whose
      // bisector is meaningless, which is enough to make a whole offset fail.
      const r = dedupe(p, GEOM_EPS_MM)
      if (r.length > 2 && dist(r[0], r[r.length - 1]) < GEOM_EPS_MM) r.pop()
      return r
    })
    .filter((r) => r.length >= 3 && Math.abs(ringArea(r)) > 1e-6)
  if (!rings.length) return []
  const areas = rings.map((r) => Math.abs(ringArea(r)))
  const depth = rings.map((r, i) =>
    rings.reduce((d, o, j) => (j !== i && areas[j] > areas[i] && ringInsideRing(r, o) ? d + 1 : d), 0),
  )
  const regions: Pt[][][] = []
  const outerIdx: number[] = []
  rings.forEach((r, i) => { if (depth[i] % 2 === 0) { regions.push([r]); outerIdx.push(i) } })
  rings.forEach((r, i) => {
    if (depth[i] % 2 !== 1) return
    let best = -1, bestA = Infinity
    outerIdx.forEach((oi, k) => {
      if (areas[oi] < bestA && ringInsideRing(r, rings[oi])) { bestA = areas[oi]; best = k }
    })
    if (best >= 0) regions[best].push(r)
  })
  return regions
}

/** Where a horizontal line at `y` crosses every ring of a region. */
export function scanlineCrossings(region: Pt[][], y: number): number[] {
  const xs: number[] = []
  for (const ring of region) {
    const n = ring.length
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n]
      // Half-open test: a vertex exactly on the scanline counts once, not
      // twice, so spans never collapse to zero width at a horizontal tangent.
      if (a.y > y === b.y > y) continue
      xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x))
    }
  }
  return xs.sort((p, q) => p - q)
}

/** Even-odd spans [x0,x1] of a region along the scanline at `y`. */
export function scanlineSpans(region: Pt[][], y: number): [number, number][] {
  const xs = scanlineCrossings(region, y)
  const spans: [number, number][] = []
  for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 1e-9) spans.push([xs[i], xs[i + 1]])
  return spans
}
