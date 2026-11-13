// Travel planning: getting the needle from the end of one thing to the start
// of the next.
//
// Travel is invisible in a preview and expensive on a machine. Every jump
// long enough to trigger the auto-trim costs a thread cut, a tie-off, a
// tie-in and a few seconds of machine time; a hundred of them is a minute of
// running and a hundred thread ends to check. The stitches themselves are
// usually fine before any of this — what separates a file that runs well from
// one that does not is almost always the travel between them.
//
// Three things happen here, in order of how much they are worth:
//
//   CHAINING   paths whose ends meet become ONE path. Imported line art
//              arrives as a pile of separate segments, and each one otherwise
//              costs its own jump and its own pair of ties.
//   ORDERING   what is left is walked nearest-first rather than in file
//              order, which is an accident of whatever drew it.
//   HIDING     a travel that stays under something already stitched, or
//              under something still to come, is SEWN rather than jumped —
//              the thread disappears beneath the covering stitches.
//
// None of this reorders OBJECTS. The sewing sequence is the digitizer's, it
// is visible in the panel, and quietly rearranging it would change which
// colour goes down first.
//
// Pure and DOM-free.

import type { Pt } from './model'
import { dist, pathLength } from './geometry'
import { insideRegion } from './fill'

/** Ends that come this close are the same point, mm. */
export const CHAIN_TOL_MM = 0.6

const first = (p: Pt[]) => p[0]
const last = (p: Pt[]) => p[p.length - 1]

/**
 * Join paths whose ends meet into continuous runs.
 *
 * This is the single biggest win available on imported artwork. An SVG of a
 * line drawing routinely contains one `<path>` per stroke segment, and a
 * closed outline is often four separate sides; sewn as they arrive, every
 * segment costs a jump, a tie-off and a tie-in, and the design comes off the
 * machine covered in thread ends.
 *
 * Paths are reversed freely — which way a segment was drawn is an accident of
 * the file — and a chain whose own two ends meet is closed into a ring.
 */
export function chainPaths(paths: readonly Pt[][], tol = CHAIN_TOL_MM): Pt[][] {
  const pool = paths.filter((p) => p.length >= 2).map((p) => p.map((q) => ({ ...q })))
  const out: Pt[][] = []
  const used = new Set<number>()

  for (let i = 0; i < pool.length; i++) {
    if (used.has(i)) continue
    used.add(i)
    let chain = pool[i]
    // Grow at BOTH ends until nothing else reaches. Growing at one end only
    // would leave a segment that joins to the start stranded, which on a
    // four-sided outline split into four paths means two chains instead of
    // one ring.
    let grew = true
    while (grew) {
      grew = false
      for (let j = 0; j < pool.length; j++) {
        if (used.has(j)) continue
        const q = pool[j]
        if (dist(last(chain), first(q)) <= tol) chain = [...chain, ...q.slice(1)]
        else if (dist(last(chain), last(q)) <= tol) chain = [...chain, ...[...q].reverse().slice(1)]
        else if (dist(first(chain), last(q)) <= tol) chain = [...q, ...chain.slice(1)]
        else if (dist(first(chain), first(q)) <= tol) chain = [...[...q].reverse(), ...chain.slice(1)]
        else continue
        used.add(j)
        grew = true
      }
    }
    // Ends that have come round to meet make a ring, which is what turns a
    // pile of sides back into something a fill or a satin border can use.
    if (chain.length > 3 && dist(first(chain), last(chain)) <= tol) {
      chain = [...chain.slice(0, -1), { ...chain[0] }]
    }
    out.push(chain)
  }
  return out
}

/**
 * Order paths so the needle travels as little as possible, nearest-first.
 *
 * Greedy, not optimal. The optimal version is a travelling-salesman problem
 * with an orientation choice per path, and the difference on real artwork is
 * a few millimetres of travel — while the difference between greedy and FILE
 * ORDER is routinely the whole width of the design, several times over.
 *
 * Each path may be walked from either end, and the end chosen is part of the
 * decision: a path reached from its far end is a travel the length of the
 * path itself, which is exactly the kind of waste file order produces.
 *
 * Closed rings are NOT reversed — their direction decides which way a satin
 * border leans and which side a fill's underlay insets to — but they may be
 * re-entered at their nearest point, which costs nothing.
 */
export function orderPaths(paths: readonly Pt[][], start?: Pt): Pt[][] {
  const pool = paths.map((p, i) => ({ p, i })).filter((e) => e.p.length >= 2)
  const out: Pt[][] = []
  let at: Pt | null = start ?? null
  const left = new Set(pool.map((e) => e.i))

  while (left.size) {
    let bestI = -1, bestD = Infinity, bestPath: Pt[] = []
    for (const e of pool) {
      if (!left.has(e.i)) continue
      if (!at) { bestI = e.i; bestD = 0; bestPath = e.p; break }
      const closed = isRing(e.p)
      if (closed) {
        const r = enterRingNear(e.p, at)
        const d = dist(at, r[0])
        if (d < bestD) { bestD = d; bestI = e.i; bestPath = r }
      } else {
        const dHead = dist(at, first(e.p))
        const dTail = dist(at, last(e.p))
        const d = Math.min(dHead, dTail)
        if (d < bestD) {
          bestD = d; bestI = e.i
          bestPath = dHead <= dTail ? e.p : [...e.p].reverse()
        }
      }
    }
    if (bestI < 0) break
    left.delete(bestI)
    out.push(bestPath)
    at = last(bestPath)
  }
  return out
}

function isRing(p: Pt[]): boolean {
  return p.length > 3 && dist(first(p), last(p)) < 1e-6
}

/**
 * Re-enter a closed ring at its nearest vertex, keeping its direction.
 *
 * A ring has no natural beginning, so where it starts is free. Spending that
 * freedom on the shortest travel is the whole of contour routing — and it
 * must not spend the ring's DIRECTION, which is load-bearing elsewhere.
 */
export function enterRingNear(ring: Pt[], from: Pt): Pt[] {
  if (!isRing(ring)) return ring
  const body = ring.slice(0, -1)
  let best = 0, bestD = Infinity
  for (let i = 0; i < body.length; i++) {
    const d = dist(body[i], from)
    if (d < bestD) { bestD = d; best = i }
  }
  const rotated = [...body.slice(best), ...body.slice(0, best)]
  rotated.push({ ...rotated[0] })
  return rotated
}

/**
 * Can the needle walk from a to b with the thread hidden?
 *
 * Travel sewn across bare fabric is a visible line on the garment, so a
 * travel is only worth sewing when something covers it. `cover` is the set of
 * regions that will have stitches over this spot — in practice the object
 * being sewn and its neighbours on the same needle.
 *
 * Sampled rather than solved analytically. The sampling step is half a
 * millimetre, which is finer than any gap a stitch could hide in anyway, and
 * an exact segment-vs-region test would still have to be sampled to answer
 * the question that actually matters: is it covered ALONG THE WHOLE WAY.
 */
export function travelIsHidden(cover: readonly Pt[][][], a: Pt, b: Pt, step = 0.5): boolean {
  if (!cover.length) return false
  const L = dist(a, b)
  const n = Math.max(2, Math.ceil(L / step))
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    if (!cover.some((region) => insideRegion(region, p))) return false
  }
  return true
}

export interface TravelReport {
  /** Total length of travel the needle makes, mm. */
  travelMm: number
  /** How many of those hops are long enough to be cut. */
  trims: number
}

/**
 * Measure the travel a given order of paths would cost.
 *
 * Used to report what the planner saved, and to keep the tests honest: an
 * optimiser that cannot be measured is an optimiser nobody can tell is
 * working.
 */
export function travelCost(paths: readonly Pt[][], trimOver: number, start?: Pt): TravelReport {
  let travelMm = 0
  let trims = 0
  let at: Pt | null = start ?? null
  for (const p of paths) {
    if (p.length < 2) continue
    if (at) {
      const d = dist(at, first(p))
      travelMm += d
      if (d > trimOver) trims++
    }
    at = last(p)
  }
  return { travelMm, trims }
}

/** Total sewn length, for reporting alongside the travel. */
export function sewnLength(paths: readonly Pt[][]): number {
  return paths.reduce((n, p) => n + pathLength(p), 0)
}
