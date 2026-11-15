// The run-stitch family: one path, one stitch length, different ways of
// laying thread along it.
//
// These are MACHINE constructions, not hand stitches. An embroidery machine
// can only put the needle down somewhere and drag thread to the next hole,
// so a hand stitch that loops under itself (a true chain) cannot be
// reproduced — it is imitated with penetrations that read the same at
// arm's length. Each function below says what it actually sews.
//
// Pure and DOM-free so the suite runs headless, like geometry/fill/satin.

import type { Pt } from './model'
import type { RunParams } from './model'
import type { Stitch } from './stitches'
import { dedupe, pathLength, resample } from './geometry'

/** Shortest stitch worth making, mm. Below this the needle strikes one hole. */
export const MIN_RUN_MM = 0.5

/** Offsets narrower than this read as a straight line — not worth the thread. */
export const MIN_SIDE_MM = 0.2

/** Cumulative arc length at each point. */
function cumulative(pts: Pt[]): number[] {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  return cum
}

/** Point at arc distance `s`, and the unit tangent there. */
function at(pts: Pt[], cum: number[], s: number): { p: Pt; tx: number; ty: number } {
  const total = cum[cum.length - 1]
  const d = Math.min(Math.max(s, 0), total)
  let i = 1
  while (i < cum.length - 1 && cum[i] < d) i++
  const a = pts[i - 1], b = pts[i]
  const segLen = cum[i] - cum[i - 1] || 1
  const t = (d - cum[i - 1]) / segLen
  const dx = (b.x - a.x) / segLen, dy = (b.y - a.y) / segLen
  return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, tx: dx, ty: dy }
}

/** Point at `s`, pushed `off` mm to the left of travel (+off = left). */
function side(pts: Pt[], cum: number[], s: number, off: number): Pt {
  const { p, tx, ty } = at(pts, cum, s)
  return { x: p.x - ty * off, y: p.y + tx * off }
}

/**
 * Double run: out along the path and back again.
 *
 * Two threads thick and, unlike bean, it ENDS WHERE IT STARTED — which is
 * why it is the one to pick when the next object is back at the beginning,
 * or when a closed shape should not finish half a lap away.
 */
export function doubleRun(path: Pt[], p: RunParams): Stitch[] {
  const base = resample(dedupe(path), Math.max(MIN_RUN_MM, p.length))
  if (base.length < 2) return base
  const back = base.slice(0, -1).reverse()
  return [...base, ...back]
}

/**
 * Bean / multiple pass: each step is sewn forward, back, forward, …
 *
 * `passes` counts traversals of each step and must be ODD — an even count
 * finishes facing backwards and the line walks back over itself. 3 is the
 * classic bean; 5 and 7 are used for outlines that have to hold a shape on
 * their own. Thread thickness is what grows, not stitch count per mm.
 */
export function multiPassRun(path: Pt[], p: RunParams, passes = 3): Stitch[] {
  const base = resample(dedupe(path), Math.max(MIN_RUN_MM, p.length))
  if (base.length < 2) return base
  const n = Math.max(1, Math.round(passes))
  const odd = n % 2 === 0 ? n + 1 : n
  const extra = (odd - 1) / 2
  const out: Stitch[] = [base[0]]
  for (let i = 1; i < base.length; i++) {
    out.push(base[i])
    for (let k = 0; k < extra; k++) out.push(base[i - 1], base[i])
  }
  return out
}

/**
 * Backstitch: the needle comes up a step ahead and goes back into the
 * previous hole, so the penetrations run p1, p0, p2, p1, p3, p2 …
 *
 * Every step is covered twice like a double run, but the doubling is LOCAL —
 * the line is solid from the first step rather than only after the return
 * leg, and it finishes at the far end. That is the difference worth knowing
 * when choosing between them.
 */
export function backStitch(path: Pt[], p: RunParams, maxSpanMm = 10): Stitch[] {
  // THE STEP IS DOUBLE THE STITCH LENGTH, and that is not avoidable. In hand
  // sewing the needle travels from p0 to p2 UNDER the cloth; a machine has no
  // under-travel, so that move lays a visible stitch two steps long. The
  // length is therefore clamped to half the machine's limit — asking for 6 mm
  // backstitch on a 10 mm machine would otherwise emit 12 mm steps for the
  // writer to split, and a split step is a different stitch in a visible place.
  const len = Math.min(Math.max(MIN_RUN_MM, p.length), maxSpanMm / 2)
  const base = resample(dedupe(path), len)
  if (base.length < 2) return base
  const out: Stitch[] = [base[1], base[0]]
  for (let i = 2; i < base.length; i++) out.push(base[i], base[i - 1])
  return out
}

/**
 * Stem / outline stitch: overlapping slanted stitches that read as a rope.
 *
 * Each stitch spans `length` but the line only advances half that, so every
 * stitch overlaps its neighbour, and the ends sit alternately either side of
 * the path by `width`/2. The alternation is what makes it a rope instead of
 * a thick line; without it this is just a double run.
 *
 * `width` under MIN_SIDE_MM degenerates to a plain overlapped run rather
 * than pretending to a texture it cannot produce at that size.
 */
export function stemStitch(path: Pt[], p: RunParams, widthMm: number): Stitch[] {
  const pts = dedupe(path)
  if (pts.length < 2) return pts as Stitch[]
  const cum = cumulative(pts)
  const total = cum[cum.length - 1]
  const len = Math.max(MIN_RUN_MM, p.length)
  if (total <= len) return resample(pts, len)
  const half = Math.max(0, widthMm) / 2
  const step = len / 2

  const out: Stitch[] = []
  let k = 0
  for (let s = 0; s < total; s += step, k++) {
    const off = half < MIN_SIDE_MM / 2 ? 0 : (k % 2 === 0 ? half : -half)
    out.push(side(pts, cum, s, off))
    // The far end of this stitch is the near end of the one after next, so
    // only the leading point is emitted each time; the final span is closed
    // below. Emitting both ends would strike the same hole twice.
  }
  out.push(side(pts, cum, total, 0))
  return out
}

/**
 * Sashiko: the long-short rhythm of a hand running stitch.
 *
 * HONEST LIMIT — a machine cannot lift the thread off the cloth, so the
 * "gap" is not an absence of stitching: it is a single long stitch spanning
 * it with no penetration in between. That is exactly how sashiko is
 * digitised, and it is why the gap is capped at `maxSpanMm`: a span longer
 * than the machine's stitch limit would be split by the writer and the
 * rhythm would be lost.
 */
export function sashikoRun(path: Pt[], p: RunParams, gapMm: number, maxSpanMm = 10): Stitch[] {
  const pts = dedupe(path)
  if (pts.length < 2) return pts as Stitch[]
  const cum = cumulative(pts)
  const total = cum[cum.length - 1]
  const dash = Math.max(MIN_RUN_MM, p.length)
  const gap = Math.min(Math.max(MIN_RUN_MM, gapMm), maxSpanMm)
  if (total <= dash) return resample(pts, dash)

  const out: Stitch[] = [at(pts, cum, 0).p]
  let s = 0
  while (s < total - 1e-9) {
    const end = Math.min(s + dash, total)
    out.push(at(pts, cum, end).p)
    if (end >= total) break
    const next = Math.min(end + gap, total)
    out.push(at(pts, cum, next).p) // the span — one stitch, no penetration inside
    if (next >= total) break
    s = next
  }
  return out
}

/**
 * Chain stitch, as a machine can make it.
 *
 * A real chain loops the thread through itself, which needs a chenille head.
 * What a flat machine can do is lay each link as a narrow closed loop whose
 * ends meet on the path, so the line reads as a chain of ovals. Each link is
 * traversed once, down one side and back the other, and consecutive links
 * share the point between them — no hole is struck twice.
 *
 * Call it what it is in the interface: an imitation, not a chain stitch.
 */
export function chainRun(path: Pt[], p: RunParams, widthMm: number): Stitch[] {
  const pts = dedupe(path)
  if (pts.length < 2) return pts as Stitch[]
  const cum = cumulative(pts)
  const total = cum[cum.length - 1]
  const link = Math.max(MIN_RUN_MM * 2, p.length)
  const half = Math.max(MIN_SIDE_MM, widthMm) / 2
  if (total < link) return resample(pts, Math.max(MIN_RUN_MM, p.length))

  const n = Math.max(1, Math.floor(total / link))
  const step = total / n
  const out: Stitch[] = [at(pts, cum, 0).p]
  for (let i = 0; i < n; i++) {
    const s0 = i * step
    const s1 = (i + 1) * step
    // Up the left side of the link, across its end, back down the right.
    out.push(side(pts, cum, s0 + step * 0.3, half))
    out.push(side(pts, cum, s0 + step * 0.7, half))
    out.push(at(pts, cum, s1).p)
    out.push(side(pts, cum, s0 + step * 0.7, -half))
    out.push(side(pts, cum, s0 + step * 0.3, -half))
    out.push(at(pts, cum, s1).p)
  }
  return out
}

/**
 * Dispatch a run object to its style.
 *
 * 'motif' is NOT handled here — it needs the motif catalogue and belongs to
 * decorative.ts. Anything unrecognised falls back to a plain run, which is
 * the one safe default: it is the construction every other style is a
 * variation of, and it always sews.
 */
export function runStyleStitches(path: Pt[], p: RunParams): Stitch[] {
  switch (p.style) {
    case 'double': return doubleRun(path, p)
    case 'multipass': return multiPassRun(path, p, p.passes ?? 3)
    case 'backstitch': return backStitch(path, p)
    case 'stem': return stemStitch(path, p, p.widthMm ?? 1.2)
    case 'sashiko': return sashikoRun(path, p, p.gapMm ?? 2)
    case 'chain': return chainRun(path, p, p.widthMm ?? 1.2)
    default: return resample(dedupe(path), Math.max(MIN_RUN_MM, p.length))
  }
}

/** Longest gap between consecutive penetrations — used by the tests. */
export function longestStep(st: Stitch[]): number {
  let m = 0
  for (let i = 1; i < st.length; i++) m = Math.max(m, Math.hypot(st[i].x - st[i - 1].x, st[i].y - st[i - 1].y))
  return m
}

/** Shortest gap — a second strike in one hole shows up here as ~0. */
export function shortestStep(st: Stitch[]): number {
  let m = Infinity
  for (let i = 1; i < st.length; i++) m = Math.min(m, Math.hypot(st[i].x - st[i - 1].x, st[i].y - st[i - 1].y))
  return st.length < 2 ? 0 : m
}

export { pathLength }

// ---------------------------------------------------------------------------
// Appliqué finishing edges
//
// A satin border is not the only way to finish an appliqué, and for some
// fabrics it is the wrong one — a heavy satin on a stretchy knit patch
// puckers it. These three are the alternatives a digitizer expects, and
// each is a different idea about how to hold an edge down.
// ---------------------------------------------------------------------------

/** Open zigzag: a satin that is deliberately not solid. Light, and it breathes. */
export function zigzagEdge(path: Pt[], widthMm: number, pitchMm: number): Stitch[] {
  const pts = dedupe(path)
  if (pts.length < 2) return pts as Stitch[]
  const cum = cumulative(pts)
  const total = cum[cum.length - 1]
  const half = Math.max(MIN_SIDE_MM, widthMm) / 2
  const n = Math.max(2, Math.round(total / Math.max(0.6, pitchMm)))
  const out: Stitch[] = []
  for (let k = 0; k <= n; k++) {
    out.push(side(pts, cum, (k / n) * total, k % 2 === 0 ? half : -half))
  }
  return out
}

/**
 * Blanket stitch: a run along the edge with a finger reaching in at
 * intervals — the classic appliqué edge, and the gentlest of the three
 * because most of the thread lies along the edge rather than across it.
 *
 * Each finger goes in and comes straight back to the SAME point on the
 * edge, which is what makes it a blanket stitch rather than a zigzag: the
 * line along the edge stays continuous.
 */
export function blanketEdge(path: Pt[], depthMm: number, pitchMm: number): Stitch[] {
  const pts = dedupe(path)
  if (pts.length < 2) return pts as Stitch[]
  const cum = cumulative(pts)
  const total = cum[cum.length - 1]
  const depth = Math.max(MIN_SIDE_MM, depthMm)
  const n = Math.max(2, Math.round(total / Math.max(1, pitchMm)))
  const out: Stitch[] = [at(pts, cum, 0).p]
  for (let k = 1; k <= n; k++) {
    const s = (k / n) * total
    const onEdge = at(pts, cum, s).p
    out.push(onEdge)                       // along the edge
    out.push(side(pts, cum, s, -depth))    // the finger, inward
    out.push(onEdge)                       // and back to the same hole's edge
  }
  return out
}

/**
 * E-stitch (buttonhole): a blanket stitch whose fingers are joined by the
 * run along the edge, so each repeat draws an E. Grips harder than a
 * blanket because the edge line is doubled between fingers.
 */
export function eStitchEdge(path: Pt[], depthMm: number, pitchMm: number): Stitch[] {
  const pts = dedupe(path)
  if (pts.length < 2) return pts as Stitch[]
  const cum = cumulative(pts)
  const total = cum[cum.length - 1]
  const depth = Math.max(MIN_SIDE_MM, depthMm)
  const n = Math.max(2, Math.round(total / Math.max(1, pitchMm)))
  const out: Stitch[] = [at(pts, cum, 0).p]
  for (let k = 1; k <= n; k++) {
    const s0 = ((k - 1) / n) * total
    const s1 = (k / n) * total
    out.push(side(pts, cum, s0, -depth))   // in
    out.push(side(pts, cum, s1, -depth))   // along, inside
    out.push(at(pts, cum, s1).p)           // back out to the edge
  }
  return out
}
