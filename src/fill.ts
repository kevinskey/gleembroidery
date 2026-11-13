// Tatami fill — the workhorse that covers an area.
//
// Rows of running stitches laid at a fixed angle and spacing. The thing that
// separates a real tatami from naive scanlines is the STAGGER: if every row
// splits its long run at the same x, the needle holes line up and a visible
// valley runs through the fill. So the split points come from one GLOBAL
// lattice whose phase advances per row, which scatters the penetrations into
// the brick pattern that reads as solid cloth.
//
// Travel between disjoint spans (the two sides of a donut, say) walks THROUGH
// the shape as ordinary stitches when the straight line stays inside, and
// only jumps when it would cross open fabric. That is what keeps a filled
// letter from being dragged across its own counter.

import type { FillParams, Pt } from './model'
import type { Stitch } from './stitches'
import { dist, pointInPoly, resample, rotatePt, scanlineSpans } from './geometry'
import { offsetPathsChecked } from './offset'

/** Even-odd containment across every ring, so holes read as outside. */
export function insideRegion(region: Pt[][], p: Pt): boolean {
  let inside = false
  for (const ring of region) if (pointInPoly(ring, p)) inside = !inside
  return inside
}

/** Does the segment a->b stay inside the region the whole way? */
function travelInside(region: Pt[][], a: Pt, b: Pt): boolean {
  const L = dist(a, b)
  const n = Math.max(2, Math.ceil(L / 0.5))
  for (let i = 1; i < n; i++) {
    const t = i / n
    if (!insideRegion(region, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) return false
  }
  return true
}

interface Row {
  y: number
  index: number
  spans: [number, number][]
}

/**
 * Needle positions across one span.
 *
 * Both ends are always hit so the fill reaches the outline exactly; the
 * interior points land on the global lattice `k*length + phase`, which is
 * what staggers one row against the next. No resulting segment can exceed
 * `length`, because the lattice pitch IS length.
 */
function spanPoints(x0: number, x1: number, length: number, phase: number): number[] {
  const out = [x0]
  const first = Math.ceil((x0 - phase) / length) * length + phase
  for (let x = first; x < x1 - 1e-9; x += length) if (x > x0 + 1e-9) out.push(x)
  out.push(x1)
  return out
}

/**
 * Fill a region (outer ring + holes) with tatami.
 * Returns stitches in document space; `start` biases which end of the first
 * row is stitched first, so the fill begins near where the needle already is.
 */
export type Report = (message: string) => void

export function tatamiFill(region: Pt[][], p: FillParams, start?: Pt, report?: Report): Stitch[] {
  if (!region.length || region[0].length < 3) return []

  // Pull compensation: the thread drags the fabric in, so the stitched shape
  // ends up smaller than the outline. Grow the region a touch to land on it.
  let work = region
  if (p.pullComp > 0) {
    const grown = offsetPathsChecked(region, p.pullComp)
    if (grown.failed) {
      // Never silently sew an uncompensated shape: it comes out undersized.
      report?.(`pull compensation could not be computed — filling the raw outline, so the stitched shape will run about ${(p.pullComp * 2).toFixed(2)} mm small`)
    } else if (grown.paths.length) {
      work = grown.paths
    }
  }

  const rad = (p.angle * Math.PI) / 180
  const cos = Math.cos(-rad), sin = Math.sin(-rad)
  const icos = Math.cos(rad), isin = Math.sin(rad)
  const rot = work.map((ring) => ring.map((q) => rotatePt(q, cos, sin)))

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const ring of rot) for (const q of ring) {
    if (q.x < minX) minX = q.x
    if (q.y < minY) minY = q.y
    if (q.x > maxX) maxX = q.x
    if (q.y > maxY) maxY = q.y
  }
  if (!isFinite(minX) || maxY - minY < 1e-6) return []

  const spacing = Math.max(0.05, p.spacing)
  const rows: Row[] = []
  let index = 0
  for (let y = minY + spacing / 2; y <= maxY; y += spacing, index++) {
    const spans = scanlineSpans(rot, y)
    if (spans.length) rows.push({ y, index, spans })
  }
  if (!rows.length) return []

  // Serpentine: rows alternate direction so consecutive rows join end to end
  // instead of flying back to the same side every time.
  const startRot = start ? rotatePt(start, cos, sin) : null
  let leftToRight = true
  if (startRot) {
    const f = rows[0].spans[0]
    leftToRight = Math.abs(startRot.x - f[0]) <= Math.abs(startRot.x - f[1])
  }

  const out: Stitch[] = []
  let prev: Pt | null = start ?? null
  const length = Math.max(0.5, p.length)
  const stagger = Math.max(0, Math.min(1, p.stagger))

  // Decide the ORDER the spans are sewn in.
  //
  // Taking each row left to right is the obvious reading and the wrong one:
  // every row that straddles a hole would jump across it, so filling a ring
  // costs one trim per row. Instead, a run of consecutive rows that all have
  // the same number of spans is treated as a set of COLUMNS — the fill walks
  // down one side of the hole and back up the other, the way it would be
  // stitched by hand, and the crossings collapse to a handful.
  const jobs: { y: number; index: number; span: [number, number] }[] = []
  for (let g = 0; g < rows.length; ) {
    const k = rows[g].spans.length
    let end = g
    while (end + 1 < rows.length && rows[end + 1].spans.length === k) end++
    const groupRows = rows.slice(g, end + 1)
    for (let c = 0; c < k; c++) {
      // Alternate the direction of travel per column so the end of one
      // column is next to the start of the following one.
      const ordered = c % 2 === 0 ? groupRows : [...groupRows].reverse()
      for (const r of ordered) jobs.push({ y: r.y, index: r.index, span: r.spans[c] })
    }
    g = end + 1
  }

  for (const job of jobs) {
    const phase = stagger > 0 ? (job.index * stagger * length) % length : 0
    const xs = spanPoints(job.span[0], job.span[1], length, phase)
    const seq = leftToRight ? xs : xs.reverse()
    const pts = seq.map((x) => rotatePt({ x, y: job.y }, icos, isin))

    if (prev) {
      const gap = dist(prev, pts[0])
      if (gap > spacing * 1.5) {
        // Not simply the next row over — decide travel vs jump.
        if (travelInside(work, prev, pts[0])) {
          // Walk there inside the shape; the under-stitches vanish beneath
          // the fill that follows.
          for (const t of resample([prev, pts[0]], length).slice(1, -1)) out.push(t)
        } else {
          out.push({ ...pts[0], jump: true })
        }
      }
    }
    for (const q of pts) out.push(q)
    prev = pts[pts.length - 1]
    leftToRight = !leftToRight
  }
  return out
}

/** Running stitch around the region, inset so it hides under the fill. */
export function edgeUnderlay(region: Pt[][], inset: number, length: number, report?: Report): Stitch[] {
  const res = offsetPathsChecked(region, -Math.abs(inset))
  if (res.failed) {
    report?.('edge underlay could not be computed — this area will sew with NO underlay')
    return []
  }
  const out: Stitch[] = []
  for (const ring of res.paths) {
    if (ring.length < 3) continue
    const pts = resample(ring, length)
    if (pts.length < 2) continue
    if (out.length) out.push({ ...pts[0], jump: true })
    for (const q of pts) out.push(q)
  }
  return out
}

/** Open zigzag across the region, at right angles to the top fill. */
export function zigzagUnderlay(region: Pt[][], angle: number, report?: Report): Stitch[] {
  return tatamiFill(
    region,
    {
      angle: angle + 90,
      spacing: 2.5,
      length: 4,
      stagger: 0,
      pullComp: 0,
      underlay: [],
      border: { enabled: false, width: 0, density: 0.4 },
    },
    undefined,
    report,
  )
}
