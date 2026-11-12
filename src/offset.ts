import pc from 'polygon-clipping'
import type { Pt } from './model'
import { fromMulti, toMulti } from './boolean'
import { GEOM_EPS_MM, dedupe, dist, ringInsideRing } from './geometry'

// Inkscape-style path offset (Ctrl+( / Ctrl+)) on flattened polyline shapes.
// Grow = union of the shape with a band swept along its boundary (per-edge
// rectangles + a disc at every vertex — a Minkowski sum with a radius-d
// disc). Shrink = the same band subtracted instead. polygon-clipping does
// the self-intersection cleanup, and toMulti/fromMulti keep letter holes
// behaving as holes (a grown O keeps its counter, a shrunk one widens it).

type Ring = [number, number][]
type Poly = Ring[]
type Multi = Poly[]

const DISC_SEGS = 16

// The disc is drawn a hair OVER radius and its sampling is rotated by an
// arbitrary phase: at exactly r with phase 0, disc vertices land exactly on
// the edge rectangles' corners and polygon-clipping's sweep line dies on the
// degenerate tangency ("Unable to find segment in SweepLine tree").
function discRing(c: Pt, r: number): Ring {
  const out: Ring = []
  const rr = r * 1.003
  for (let i = 0; i < DISC_SEGS; i++) {
    const a = 0.3781 + (i / DISC_SEGS) * Math.PI * 2
    out.push([c.x + rr * Math.cos(a), c.y + rr * Math.sin(a)])
  }
  return out
}

// One polygon per edge/vertex of every ring in the shape, all radius d.
function boundaryBand(m: Multi, d: number): Multi {
  const band: Multi = []
  for (const poly of m) {
    for (const ring of poly) {
      const n = ring.length
      for (let i = 0; i < n; i++) {
        const [ax, ay] = ring[i]
        const [bx, by] = ring[(i + 1) % n]
        band.push([discRing({ x: ax, y: ay }, d)])
        const dx = bx - ax, dy = by - ay
        const len = Math.hypot(dx, dy)
        if (len < 1e-6) continue
        const nx = (-dy / len) * d, ny = (dx / len) * d
        band.push([[
          [ax + nx, ay + ny],
          [bx + nx, by + ny],
          [bx - nx, by - ny],
          [ax - nx, ay - ny],
        ]])
      }
    }
  }
  return band
}

// Offset a closed shape outward (delta > 0) or inward (delta < 0) by |delta|
// mm. Returns the new boundary as closed polylines; [] when an inset
// swallows the whole shape.
export function offsetPaths(paths: Pt[][], delta: number): Pt[][] {
  const m = toMulti(paths)
  if (!m.length || !delta) return paths
  const band = boundaryBand(m, Math.abs(delta))
  const out =
    delta > 0
      ? pc.union(m, ...band)
      : pc.difference(m, ...band)
  return fromMulti(out as Multi)
}

/**
 * offsetPaths that cannot take the app down.
 *
 * polygon-clipping's sweep line throws ("Unable to complete output ring") on
 * exact tangencies, and an offset band is nothing but near-tangencies: a
 * sampled circle offset by exactly 1 mm puts hundreds of disc arcs flush
 * against their neighbours. Snapping the input off the exact grid and
 * nudging the radius by a fraction of a percent moves the degeneracy without
 * moving the geometry anywhere a needle could tell. If every attempt still
 * fails the caller gets [] and drops the underlay — a missing underlay is a
 * softer failure than a design that will not generate.
 */
export function offsetPathsSafe(paths: Pt[][], delta: number): Pt[][] {
  return offsetPathsChecked(paths, delta).paths
}

export interface OffsetResult {
  paths: Pt[][]
  /** True when every attempt failed and `paths` is empty as a RESULT, not a shape. */
  failed: boolean
  attempts: number
}

/**
 * The same thing, but it tells you when it gave up.
 *
 * Returning a bare [] made failure indistinguishable from "the inset
 * swallowed the shape", so callers wrote `if (out.length)` and a design whose
 * offset threw simply sewed with no underlay and no pull compensation, with
 * nothing reported. Underlay is the DEFAULT for fills, so that is a silent
 * quality failure on exactly the shapes hardest to offset.
 */
export function offsetPathsChecked(paths: Pt[][], delta: number): OffsetResult {
  if (!delta) return { paths, failed: false, attempts: 0 }
  const snapped = paths.map((r) => r.map((p) => ({ x: Math.round(p.x * 1e4) / 1e4, y: Math.round(p.y * 1e4) / 1e4 })))

  // FAST PATH FIRST, deliberately.
  //
  // offsetPaths builds a Minkowski band — a disc at every vertex plus a
  // rectangle along every edge — and unions the lot. On a 256-vertex ring
  // that is 512 polygons through the sweep line, measured at 500-900 ms for
  // ONE offset, and it is where essentially all of this engine's runtime was
  // going. Embroidery offsets are tiny next to the shapes they act on (0.15 mm
  // of pull compensation, a millimetre of underlay inset), and over that range
  // a per-vertex bisector offset is exact and about three hundred times
  // faster. It is validated below, and the clipper remains the fallback for
  // the large or awkward offsets where the naive method genuinely breaks.
  if (isSmallOffset(snapped, delta)) {
    const quick = bisectorOffset(snapped, delta)
    if (quick) return { paths: quick, failed: false, attempts: 0 }
  }

  // Each failed attempt is expensive — the sweep line does most of its work
  // before it throws — so there is no point grinding through many nudges now
  // that the bisector fallback below is validated and cheap. Two retries
  // catch the ordinary tangency; past that, fall back.
  const nudges = [1, 1.0007, 0.9991]
  let threw = false
  for (let i = 0; i < nudges.length; i++) {
    try {
      const out = offsetPaths(snapped, delta * nudges[i])
      // An empty result from a clean run is a real answer: the inset ate the
      // shape. Only a thrown attempt counts as a failure to compute.
      return { paths: out, failed: false, attempts: i + 1 }
    } catch {
      threw = true
    }
  }
  // The clipper is out too. Rather than drop the underlay and the
  // compensation — a silent quality failure on exactly the shapes that are
  // hardest to offset — accept the bisector result even unguarded by size.
  const fb = bisectorOffset(snapped, delta)
  if (fb) return { paths: fb, failed: false, attempts: nudges.length + 1 }
  return { paths: [], failed: threw, attempts: nudges.length + 1 }
}

/**
 * Offset every vertex along the bisector of its two edges.
 *
 * This is the textbook naive offset: correct for small deltas, and prone to
 * self-intersection once the offset exceeds a local concave radius. That is
 * acceptable HERE because it only runs when the real clipper has already
 * failed, and because the deltas in play are small — an underlay inset of
 * about a millimetre, a pull compensation of a fraction of one.
 *
 * The guard is an area check: a correct offset changes a ring's area by
 * roughly perimeter x delta. A ring that has folded through itself misses
 * that badly, and is rejected rather than handed to a scanline fill that
 * would read its crossings as spans.
 */
function bisectorOffset(paths: Pt[][], delta: number): Pt[][] | null {
  // Which rings are HOLES? Offsetting a region moves its outline and its
  // holes in OPPOSITE radial directions — inset an annulus and the outside
  // comes in while the hole opens up. Deciding that from winding alone is
  // unreliable, because nothing re-winds the rings that arrive from an SVG,
  // so it is decided by containment, the same way regions are formed.
  // Nesting by the SAME rule the rest of the engine uses, including the area
  // guard. Deciding it from one interior probe classified the outline of any
  // frame as a hole — its centre sits in the window — and every offset on a
  // box, plaque or counter then ran backwards, putting edge underlay outside
  // the finished border in bare fabric.
  const areas = paths.map((r) => Math.abs(ringArea(r)))
  const isHole = paths.map((r, i) =>
    paths.reduce((d, o, j) => (j !== i && areas[j] > areas[i] && ringInsideRing(r, o) ? d + 1 : d), 0) % 2 === 1,
  )

  const out: Pt[][] = []
  for (let idx = 0; idx < paths.length; idx++) {
    // Collapse coincident points first: a degenerate edge has no direction,
    // so its bisector is arbitrary and can throw the offset off entirely.
    const ring = dedupe(paths[idx], GEOM_EPS_MM)
    if (ring.length > 2 && dist(ring[0], ring[ring.length - 1]) < GEOM_EPS_MM) ring.pop()
    const n = ring.length
    if (n < 3) continue

    // Build the displacement once, then decide its SIGN from what it actually
    // did to the ring's area rather than from an assumed winding.
    const step = (dir: number): Pt[] => {
      const moved: Pt[] = []
      for (let i = 0; i < n; i++) {
        const p = ring[(i - 1 + n) % n], c = ring[i], q = ring[(i + 1) % n]
        const n1 = unitNormal(p, c), n2 = unitNormal(c, q)
        let bx = n1.x + n2.x, by = n1.y + n2.y
        const len = Math.hypot(bx, by)
        if (len < 1e-9) { moved.push({ ...c }); continue }
        bx /= len; by /= len
        // Lengthen along the bisector so the offset edges stay parallel at
        // corners instead of pinching in.
        const cosHalf = Math.max(0.25, bx * n1.x + by * n1.y)
        const d = (Math.abs(delta) * dir) / cosHalf
        moved.push({ x: c.x + bx * d, y: c.y + by * d })
      }
      return moved
    }

    // Inset (delta<0): the outline must lose area, a hole must gain it.
    // Grow (delta>0): the reverse.
    const wantGrowth = isHole[idx] ? delta < 0 : delta > 0
    const before = Math.abs(ringArea(ring))
    let moved = step(1)
    if ((Math.abs(ringArea(moved)) > before) !== wantGrowth) moved = step(-1)

    const after = Math.abs(ringArea(moved))
    const expected = perimeter(ring) * Math.abs(delta)
    if (after <= 1e-9) return null
    // Magnitude sanity only — direction is now settled above.
    if (Math.abs(after - before) > expected * 1.8 + 1e-6) return null
    if (selfIntersects(moved)) return null
    out.push(moved)
  }
  return out.length ? out : null
}

/** Is this offset small enough that a naive bisector offset is trustworthy? */
function isSmallOffset(paths: Pt[][], delta: number): boolean {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const r of paths) for (const p of r) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  if (!isFinite(minX)) return false
  const smallest = Math.min(maxX - minX, maxY - minY)
  return smallest > 0 && Math.abs(delta) <= smallest * 0.12
}

/**
 * Does the ring cross itself? The area check catches gross folding; this
 * catches a local pinch that happens to preserve area. Skipped on very dense
 * rings, where the O(n^2) sweep would cost more than it saves.
 */
function selfIntersects(ring: Pt[]): boolean {
  const n = ring.length
  if (n > 600) return false
  for (let i = 0; i < n; i++) {
    const a1 = ring[i], a2 = ring[(i + 1) % n]
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue // adjacent across the seam
      if (segmentsCross(a1, a2, ring[j], ring[(j + 1) % n])) return true
    }
  }
  return false
}

function segmentsCross(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x)
  if (Math.abs(d) < 1e-12) return false
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9
}

function unitNormal(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x, dy = b.y - a.y
  const l = Math.hypot(dx, dy) || 1
  return { x: dy / l, y: -dx / l }
}

function perimeter(ring: Pt[]): number {
  let L = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    L += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return L
}

function ringArea(ring: Pt[]): number {
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}
