// Fill + rungs -> satin columns.
//
// The automatic route — thin the shape to a skeleton and hope the branches
// are strokes — cannot recover junction topology from an outline. That is
// not an implementation problem. Ink/Stitch, the mature open-source
// embroidery project, ships this same conversion and documents it as
// "semi-automatic": the user draws RUNGS to say how the shape is to be read,
// and marks intersections with BRIDGES, and "unbridged intersections simply
// leave a gap". They arrived there after years. So do we.
//
// A rung is a line drawn ACROSS the shape. Two consecutive rungs delimit a
// section, and that section's two sides ARE the rails of a satin column —
// which is the same statement the Column tool makes when you click alternate
// sides, just made over an outline that already exists.
//
// THE LIMIT, stated rather than worked around: this reads ONE stroke per
// outline. A whole letter has junctions, and a section spanning one is
// nonsense however the rungs are placed — split the fill into strokes first.
// Ink/Stitch says the same: "it can be necessary that you need to split up
// your fill to simpler shapes".
//
// Pure and DOM-free.

import type { Pt } from './model'

export interface Rung { a: Pt; b: Pt }

export interface RungColumns {
  columns: { left: Pt[]; right: Pt[] }[]
  warnings: string[]
}

const EPS = 1e-9

/**
 * Where a rung crosses a ring, as a position along it.
 *
 * The position is `segment index + fraction`, which orders crossings without
 * needing arc lengths, and is exact at a vertex.
 */
function crossings(ring: Pt[], r: Rung): { t: number; p: Pt }[] {
  const out: { t: number; p: Pt }[] = []
  const rx = r.b.x - r.a.x, ry = r.b.y - r.a.y
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length]
    const sx = q.x - p.x, sy = q.y - p.y
    const den = rx * sy - ry * sx
    if (Math.abs(den) < EPS) continue // parallel
    const dx = p.x - r.a.x, dy = p.y - r.a.y
    const u = (dx * sy - dy * sx) / den // along the rung
    const v = (dx * ry - dy * rx) / den // along the ring segment
    if (u < -1e-6 || u > 1 + 1e-6) continue
    if (v < -1e-6 || v > 1 + 1e-6) continue
    out.push({ t: i + Math.min(1, Math.max(0, v)), p: { x: p.x + sx * v, y: p.y + sy * v } })
  }
  // A rung passing exactly through a vertex is found on both of its
  // segments; the same crossing twice would be read as two sides.
  out.sort((a, b) => a.t - b.t)
  const dedup: { t: number; p: Pt }[] = []
  for (const c of out) {
    const last = dedup[dedup.length - 1]
    if (last && Math.hypot(c.p.x - last.p.x, c.p.y - last.p.y) < 1e-6) continue
    dedup.push(c)
  }
  return dedup
}

/** The run of ring points from t0 forward to t1, wrapping if it has to. */
function arc(ring: Pt[], t0: number, t1: number, p0: Pt, p1: Pt): Pt[] {
  const n = ring.length
  const out: Pt[] = [p0]
  let i = Math.floor(t0) + 1
  const end = Math.floor(t1)
  let guard = 0
  while (guard++ <= n) {
    const idx = ((i % n) + n) % n
    if (i > end && (t1 >= t0 || i % n === ((end % n) + n) % n)) break
    out.push(ring[idx])
    if (idx === ((end % n) + n) % n && (t1 > t0 || guard > 1)) break
    i++
  }
  out.push(p1)
  // Drop any duplicate that the ends created.
  return out.filter((q, k) => k === 0 || Math.hypot(q.x - out[k - 1].x, q.y - out[k - 1].y) > 1e-6)
}

/**
 * Columns delimited by the rungs drawn across a closed outline.
 *
 * Every rung must cross the outline exactly TWICE — once on each side. A
 * rung that misses, stops short, or runs the length of the shape instead of
 * across it is reported and skipped, because a rung is a statement about
 * which two sides pair, and one that does not cross twice has not made it.
 */
export function columnsFromRungs(path: Pt[], rungs: Rung[]): RungColumns {
  const warnings: string[] = []
  const ring = path.length > 2 && Math.hypot(path[0].x - path[path.length - 1].x, path[0].y - path[path.length - 1].y) < 1e-6
    ? path.slice(0, -1) : path.slice()
  if (ring.length < 3) return { columns: [], warnings: ['that outline is not a closed shape'] }
  if (rungs.length < 2) {
    return {
      columns: [],
      warnings: ['draw at least two rungs across the shape with the Angle tool (G) — a rung says which two sides pair'],
    }
  }

  const cuts: { lo: number; hi: number; pLo: Pt; pHi: Pt }[] = []
  let missed = 0
  for (const r of rungs) {
    const x = crossings(ring, r)
    if (x.length !== 2) { missed++; continue }
    cuts.push({ lo: x[0].t, hi: x[1].t, pLo: x[0].p, pHi: x[1].p })
  }
  if (missed) {
    warnings.push(`${missed} rung(s) did not cross the outline exactly twice and were ignored — a rung runs ACROSS the shape, side to side`)
  }
  if (cuts.length < 2) {
    return { columns: [], warnings: [...warnings, 'fewer than two usable rungs — nothing to make a column between'] }
  }

  // Order along the first side. The second side's positions then run the
  // other way, because the ring comes back down it.
  cuts.sort((a, b) => a.lo - b.lo)

  const columns: { left: Pt[]; right: Pt[] }[] = []
  for (let i = 0; i + 1 < cuts.length; i++) {
    const A = cuts[i], B = cuts[i + 1]
    const left = arc(ring, A.lo, B.lo, A.pLo, B.pLo)
    const right = arc(ring, B.hi, A.hi, B.pHi, A.pHi)
    if (left.length < 2 || right.length < 2) continue
    columns.push({ left, right })
  }
  if (!columns.length) warnings.push('the rungs did not delimit any section — are they all across the same stroke?')
  return { columns, warnings }
}
