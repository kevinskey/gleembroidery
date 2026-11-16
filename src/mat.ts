// Exact medial axis, via flo-mat.
//
// The raster route — draw the shape at 10 px/mm, thin it to a skeleton,
// read a distance transform — works, and everything about it is an
// approximation: the centreline wanders by a pixel, the half-width is
// quantised, and a junction is only recognisable because the distance
// field BALLOONS there. It also needs a canvas, so none of it can be
// tested headlessly.
//
// flo-mat computes the real thing from the outline itself. Each point on
// the axis carries its inscribed circle — centre and radius — so the
// half-width is exact rather than sampled, and the branch structure is the
// medial axis tree, so a junction is a branch point rather than a bulge to
// be recognised. Measured on an 8 mm bar: radius 4.00.
//
// It does NOT say which branches are strokes. That is still the digitizer's
// to state, with rungs — see rungs.ts.
//
// Pure and DOM-free, which the raster route never was.

import type { Pt } from './model'

// flo-boolean calls Map.prototype.getOrInsert, a TC39 proposal that no
// engine ships yet. Five lines here rather than a polyfill dependency, and
// it must load before flo-mat does anything — including in the browser.
const M = Map.prototype as unknown as Record<string, unknown>
if (typeof M.getOrInsert !== 'function') {
  M.getOrInsert = function (this: Map<unknown, unknown>, k: unknown, v: unknown) {
    if (!this.has(k)) this.set(k, v)
    return this.get(k)
  }
}

/** A point on the medial axis, with the half-width of the shape there. */
export interface AxisPoint { p: Pt; r: number }

/** How finely a branch is resampled along its length, mm. */
const STEP_MM = 0.6

/** Twice the signed area; its sign is the winding direction. */
function signedArea(ring: Pt[]): number {
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length]
    a += p.x * q.y - q.x * p.y
  }
  return a
}

function toLoops(paths: Pt[][]): number[][][][] {
  // loop -> bezier -> point -> coordinate.
  //
  // A HOLE MUST BE WOUND THE OTHER WAY. Handed an outer ring and a counter
  // both running the same direction, flo-mat returns a mat with an EMPTY
  // traversal — no error, no circles, nothing — so every letter with a
  // counter silently produced no axis at all. o, a, e, b, d, g, p, q: most
  // of a word. The outer ring is made positive and every later ring
  // negative, which is the outer/holes order toRegions already produces.
  const loops: number[][][][] = []
  const rings: Pt[][] = []
  for (const path of paths) {
    const ring = path.length > 2
      && Math.hypot(path[0].x - path[path.length - 1].x, path[0].y - path[path.length - 1].y) < 1e-9
      ? path.slice(0, -1) : path.slice()
    if (ring.length >= 3) rings.push(ring)
  }
  rings.forEach((ring, idx) => {
    const want = idx === 0 ? 1 : -1
    const oriented = Math.sign(signedArea(ring)) === want ? ring : [...ring].reverse()
    const segs: number[][][] = []
    for (let i = 0; i < oriented.length; i++) {
      const a = oriented[i], b = oriented[(i + 1) % oriented.length]
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) continue
      segs.push([[a.x, a.y], [b.x, b.y]])
    }
    if (segs.length >= 3) loops.push(segs)
  })
  return loops
}

/** Straight-line resample so a branch has points at a usable pitch. */
function densify(pts: AxisPoint[], step = STEP_MM): AxisPoint[] {
  if (pts.length < 2) return pts
  const out: AxisPoint[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const d = Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y)
    const n = Math.max(1, Math.round(d / step))
    for (let k = 1; k <= n; k++) {
      const t = k / n
      out.push({
        p: { x: a.p.x + (b.p.x - a.p.x) * t, y: a.p.y + (b.p.y - a.p.y) * t },
        r: a.r + (b.r - a.r) * t,
      })
    }
  }
  return out
}

/**
 * Branches of the medial axis of `paths`, each a run of axis points.
 *
 * Returns null when the library cannot handle the shape, so a caller can
 * fall back rather than lose the object. Degenerate outlines, self-touching
 * traces and the occasional shape it simply refuses all land here, and a
 * traced logo is exactly where those turn up.
 */
export async function axisBranches(paths: Pt[][]): Promise<AxisPoint[][] | null> {
  const loops = toLoops(paths)
  if (!loops.length) return null
  try {
    // LOADED ON DEMAND. flo-mat pulls in flo-boolean and the pair weigh a
    // quarter of a megabyte — half the application again — for a feature
    // used on a menu click. A document that never converts a traced shape
    // should not download the geometry to do it.
    const { findMats, traverseEdges } = await import('flo-mat')
    const mats = (findMats as unknown as (l: unknown, n: number) => unknown[])(loops, 3)
    if (!mats?.length) return null

    // Collect the axis as a GRAPH of inscribed circles.
    //
    // getBranches() looked like the obvious call and is not: it returns
    // sparse endpoints, so a plain rectangle came back as a single node and
    // a T lost its stem entirely. traverseEdges walks the real tree, and
    // every edge is a span between two circles.
    const key = (c: number[]) => `${c[0].toFixed(4)},${c[1].toFixed(4)}`
    const node = new Map<string, AxisPoint>()
    const adj = new Map<string, Set<string>>()
    const link = (a: string, b: string) => {
      if (!adj.has(a)) adj.set(a, new Set())
      if (!adj.has(b)) adj.set(b, new Set())
      adj.get(a)!.add(b)
      adj.get(b)!.add(a)
    }
    type Circle = { center: number[]; radius: number }
    type Cp = { pointOnShape?: { circle?: Circle }; next?: Cp }
    for (const mat of mats) {
      const root = (mat as { cpNode?: unknown }).cpNode
      if (!root) continue
      ;(traverseEdges as unknown as (c: unknown, f: (cp: Cp) => void) => void)(root, (cp) => {
        const a = cp.pointOnShape?.circle
        const b = cp.next?.pointOnShape?.circle
        if (!a || !Number.isFinite(a.radius)) return
        const ka = key(a.center)
        if (!node.has(ka)) node.set(ka, { p: { x: a.center[0], y: a.center[1] }, r: a.radius })
        if (!b || !Number.isFinite(b.radius)) return
        const kb = key(b.center)
        if (!node.has(kb)) node.set(kb, { p: { x: b.center[0], y: b.center[1] }, r: b.radius })
        if (ka !== kb) link(ka, kb)
      })
    }
    if (!node.size) return null

    // Walk maximal runs between JUNCTIONS and LEAVES. A junction is a node
    // of degree 3 or more — which is what makes this better than reading a
    // ballooning distance field: here it is the graph saying so.
    const branches: AxisPoint[][] = []
    const seen = new Set<string>()
    const deg = (k: string) => adj.get(k)?.size ?? 0
    const ends = [...adj.keys()].filter((k) => deg(k) !== 2)

    const walk = (from: string, to: string) => {
      const edge = `${from}|${to}`
      if (seen.has(edge)) return
      const run: AxisPoint[] = [node.get(from)!]
      let prev = from, cur = to
      // BOUNDED. The axis of a ring — an O, an o, the bowl of a b — is a
      // CYCLE: every node has degree 2 and the walk never meets an end. This
      // ran until the array could not grow, threw RangeError, and the catch
      // reported it as a shape the library could not handle. It was a shape
      // this function could not walk.
      for (let step = 0; step <= node.size; step++) {
        seen.add(`${prev}|${cur}`)
        seen.add(`${cur}|${prev}`)
        run.push(node.get(cur)!)
        if (cur === from) break // closed the loop
        if (deg(cur) !== 2) break
        const next = [...(adj.get(cur) ?? [])].find((k) => k !== prev)
        if (!next) break
        prev = cur
        cur = next
      }
      if (run.length >= 2) branches.push(densify(run))
    }

    for (const e of ends) for (const n of adj.get(e) ?? []) walk(e, n)
    // A closed loop of degree-2 nodes (a ring, an O) has no ends at all.
    if (!branches.length) {
      const first = [...adj.keys()][0]
      if (first) for (const n of adj.get(first) ?? []) walk(first, n)
    }
    return branches.length ? branches : null
  } catch {
    return null
  }
}

/**
 * Rails either side of a branch, at the shape's own half-width.
 *
 * The raster version sampled a quantised distance transform for this; here
 * the radius IS the half-width, so the rails sit on the outline rather than
 * near it.
 */
export function railsFromAxis(branch: AxisPoint[]): { left: Pt[]; right: Pt[] } {
  const left: Pt[] = [], right: Pt[] = []
  for (let i = 0; i < branch.length; i++) {
    const a = branch[Math.max(0, i - 1)].p
    const b = branch[Math.min(branch.length - 1, i + 1)].p
    let tx = b.x - a.x, ty = b.y - a.y
    const len = Math.hypot(tx, ty)
    if (len < 1e-9) continue
    tx /= len; ty /= len
    const { p, r } = branch[i]
    left.push({ x: p.x - ty * r, y: p.y + tx * r })
    right.push({ x: p.x + ty * r, y: p.y - tx * r })
  }
  return { left, right }
}

/**
 * Trim a branch back out of its junctions, and say whether what is left is
 * a stroke.
 *
 * Same judgement as skeleton.ts's trimAtJunctions and for the same reason —
 * at a junction the inscribed circle spans BOTH strokes, so a branch running
 * in carries their combined width — but made on exact radii rather than on a
 * quantised distance field. On a T with 8 mm arms the junction circle is
 * 5.00 against the stroke's 4.00, and that is measured, not estimated.
 */
export function trimAxis(
  branch: AxisPoint[], balloon = 1.08, reachFactor = 1.5, minLengthFactor = 1,
): AxisPoint[] | null {
  if (branch.length < 3) return null
  const sorted = branch.map((a) => a.r).sort((x, y) => x - y)
  const med = sorted[sorted.length >> 1]
  if (!(med > 0)) return null

  // TWO conditions, not one. The raster version used a loose 1.55 ratio
  // because a quantised distance field is noisy; exact radii let the
  // threshold be tight — a T with 8 mm arms has a junction circle of 5.00
  // against the stroke's 4.00, a ratio of only 1.25, which 1.55 never caught.
  //
  // But a tight ratio alone would eat a TAPER, where one end is legitimately
  // wider. A junction balloon decays within about a stroke width of the
  // meeting point, while a taper runs the length of the stroke — so the trim
  // is also bounded by how FAR it may reach in. A taper loses at most a
  // couple of half-widths; a junction loses the blob, which decays within
  // about one stroke width of the meeting point.
  const reach = med * reachFactor
  let lo = 0, hi = branch.length - 1
  let walked = 0
  while (lo < hi && branch[lo].r > med * balloon && walked < reach) {
    walked += Math.hypot(branch[lo + 1].p.x - branch[lo].p.x, branch[lo + 1].p.y - branch[lo].p.y)
    lo++
  }
  walked = 0
  while (hi > lo && branch[hi].r > med * balloon && walked < reach) {
    walked += Math.hypot(branch[hi].p.x - branch[hi - 1].p.x, branch[hi].p.y - branch[hi - 1].p.y)
    hi--
  }
  const kept = branch.slice(lo, hi + 1)
  if (kept.length < 3) return null

  // Shorter than its own WIDTH is not a stroke — it is what the thinning
  // left inside a junction. Requiring several widths rejected the 12 mm arms
  // of a 8 mm-wide T, which are strokes by any reading.
  let len = 0
  for (let i = 1; i < kept.length; i++) len += Math.hypot(kept[i].p.x - kept[i - 1].p.x, kept[i].p.y - kept[i - 1].p.y)
  return len < med * 2 * minLengthFactor ? null : kept
}
