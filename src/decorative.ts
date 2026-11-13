// Decorative stitch styles: motif runs and fills, stippling, cross-stitch,
// and contour/echo fill.
//
// These are not variations on tatami with different numbers. Each one is a
// different idea about how thread covers ground, and each is chosen for a
// reason a tatami cannot serve:
//
//   MOTIF      a shape stamped repeatedly along a line or across an area —
//              a border of hearts, a field of stars. The unit is a drawing,
//              not a stitch.
//   STIPPLE    one wandering line that never crosses itself, covering ground
//              loosely. It is what flattens a background without stiffening
//              it, and it is the cheapest coverage per stitch there is.
//   CROSS      a grid of X's: counted-thread embroidery imitated by machine.
//              Deliberately coarse — the gaps are the look.
//   ECHO       concentric outlines following the shape inwards. The shape's
//              own silhouette becomes the texture, which is why it reads as
//              deliberate where a tatami at the same density reads as flat.
//
// DETERMINISM. Stippling looks organic, and the obvious way to get that is
// Math.random(). That is forbidden here: the same document must produce the
// same stitch file every time, or an approved sewout says nothing about the
// next export of the same design. The wander therefore comes from a hashed
// sequence seeded by position — reproducible, and uncorrelated enough to read
// as hand-guided.
//
// Pure and DOM-free.

import type { FillParams, Pt, RunParams } from './model'
import type { Stitch } from './stitches'
import { dedupe, dist, pathLength, resample, rotatePt, scanlineSpans, tangentAt } from './geometry'
import { offsetPathsChecked } from './offset'
import { insideRegion } from './fill'

// ---------------------------------------------------------------------------
// The motif library
// ---------------------------------------------------------------------------
//
// Each motif is one or more polylines in a UNIT cell: x runs 0..1 along the
// path, y runs -0.5..0.5 across it. Keeping them unit-sized is what lets the
// same drawing be a 3 mm border and a 12 mm one without a second definition,
// and what lets a motif bend round a curve — the cell is mapped through the
// path's local frame, so the motif follows the line rather than being pasted
// flat onto it.
//
// Every motif ENTERS at (0, 0) and LEAVES at (1, 0). That is not decoration:
// it is what lets one motif run straight into the next with no connecting
// stitch and no jump. A motif that ended anywhere else would need a travel
// stitch between every pair, which at 3 mm spacing is a second row of
// stitching nobody asked for.

export interface Motif {
  id: string
  label: string
  /** Polylines in the unit cell. The first starts at (0,0), the last ends at (1,0). */
  strokes: Pt[][]
}

const P = (x: number, y: number): Pt => ({ x, y })

/** A circular arc inside the unit cell, sampled for stitching. */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, n = 10): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n
    return P(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
  })
}

export const MOTIFS: Motif[] = [
  {
    id: 'zigzag', label: 'Zigzag',
    strokes: [[P(0, 0), P(0.25, -0.5), P(0.75, 0.5), P(1, 0)]],
  },
  {
    id: 'wave', label: 'Wave',
    strokes: [[
      P(0, 0),
      ...Array.from({ length: 11 }, (_, i) => {
        const u = (i + 1) / 12
        return P(u, Math.sin(u * Math.PI * 2) * 0.5)
      }),
      P(1, 0),
    ]],
  },
  {
    id: 'diamond', label: 'Diamond',
    strokes: [[P(0, 0), P(0.5, -0.5), P(1, 0), P(0.5, 0.5), P(0, 0), P(1, 0)]],
  },
  {
    id: 'blanket', label: 'Blanket',
    // Out across the line, back, then on — the edge finish on a felt appliqué.
    strokes: [[P(0, 0), P(0, -0.5), P(0, 0), P(1, 0)]],
  },
  {
    id: 'cross', label: 'Cross',
    strokes: [[P(0, 0), P(0.5, -0.5), P(0.5, 0.5), P(0.5, 0), P(1, 0)]],
  },
  {
    id: 'scallop', label: 'Scallop',
    strokes: [[P(0, 0), ...arc(0.5, 0, 0.5, Math.PI, 0), P(1, 0)]],
  },
  {
    id: 'star', label: 'Star',
    strokes: [[
      P(0, 0),
      ...Array.from({ length: 11 }, (_, i) => {
        // Five points, alternating outer and inner radius, walked as one
        // continuous line so it sews without a jump.
        const a = -Math.PI / 2 + (i * Math.PI) / 5
        const r = (i % 2 === 0 ? 0.5 : 0.21)
        return P(0.5 + Math.cos(a) * r, Math.sin(a) * r)
      }),
      P(1, 0),
    ]],
  },
  {
    id: 'leaf', label: 'Leaf',
    strokes: [[
      P(0, 0),
      ...arc(0.5, 0, 0.5, Math.PI, 0, 8).map((q) => P(q.x, q.y * 0.8)),
      ...arc(0.5, 0, 0.5, 0, -Math.PI, 8).map((q) => P(q.x, q.y * 0.8)),
      P(1, 0),
    ]],
  },
]

export const MOTIF_IDS = MOTIFS.map((m) => m.id)

export function motifById(id: string): Motif {
  return MOTIFS.find((m) => m.id === id) ?? MOTIFS[0]
}

export interface MotifParams {
  id: string
  /** Length of one motif along the path, mm. */
  widthMm: number
  /** Height across the path, mm. */
  heightMm: number
  /** Gap between consecutive motifs, mm. 0 runs them end to end. */
  gapMm: number
}

export const DEFAULT_MOTIF = (): MotifParams => ({
  id: 'zigzag', widthMm: 4, heightMm: 3, gapMm: 0,
})

/** Smallest motif worth sewing, mm — below this it is a blob of thread. */
export const MIN_MOTIF_MM = 1.5

/**
 * Stamp a motif repeatedly along a path.
 *
 * The motif is mapped through the path's LOCAL FRAME at each point rather
 * than placed as a rigid stamp: the cell's x runs along the path and its y
 * across it, sampled per vertex, so the motif bends round a curve the way a
 * drawn border does. A rigid stamp rotated once per instance would stand off
 * the line wherever the line turns.
 *
 * Whole motifs only. A path that does not divide evenly is covered by as many
 * as fit and the remainder is run plain — a half heart at the end of a border
 * is worse than a short gap, and silently stretching them to fit would make
 * two borders of the same motif different sizes.
 */
export function motifRun(path: Pt[], p: MotifParams, run: RunParams): Stitch[] {
  const pts = dedupe(path)
  if (pts.length < 2) return []
  const motif = motifById(p.id)
  const w = Math.max(MIN_MOTIF_MM, p.widthMm)
  const h = Math.max(0, p.heightMm)
  const gap = Math.max(0, p.gapMm)
  const total = pathLength(pts)
  const pitch = w + gap
  const count = Math.floor((total + gap + 1e-9) / pitch)
  if (count < 1) {
    // Too short for even one: a plain run is the honest fallback, and the
    // caller reports it.
    return resample(pts, Math.max(0.5, run.length))
  }

  // Walk the path finely so the local frame is available at any arc length.
  const fine = resample(pts, Math.min(0.3, w / 8))
  const cum = [0]
  for (let i = 1; i < fine.length; i++) cum.push(cum[i - 1] + dist(fine[i - 1], fine[i]))
  const len = cum[cum.length - 1]
  const closed = dist(pts[0], pts[pts.length - 1]) < 1e-6

  const frameAt = (s: number) => {
    const target = Math.max(0, Math.min(len, s))
    let i = 1
    while (i < cum.length - 1 && cum[i] < target) i++
    const a = fine[i - 1], b = fine[i]
    const span = cum[i] - cum[i - 1]
    const t = span > 1e-12 ? (target - cum[i - 1]) / span : 0
    const at = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    const tan = tangentAt(fine, i, closed)
    return { at, tan, nrm: { x: -tan.y, y: tan.x } }
  }

  const out: Stitch[] = []
  const step = Math.max(0.5, run.length)
  for (let k = 0; k < count; k++) {
    const s0 = k * pitch
    for (const stroke of motif.strokes) {
      // Resample the motif in UNIT space first, so a long straight arm of a
      // motif is broken into sewable stitches like anything else.
      const unit = resampleUnit(stroke, step / Math.max(w, h, 1e-6))
      for (const u of unit) {
        const f = frameAt(s0 + u.x * w)
        out.push({
          x: f.at.x + f.nrm.x * u.y * h,
          y: f.at.y + f.nrm.y * u.y * h,
        })
      }
    }
    // Carry on to the start of the next motif along the path itself.
    if (gap > 1e-9 && k < count - 1) {
      const a = frameAt(s0 + w).at
      const b = frameAt(s0 + pitch).at
      for (const q of resample([a, b], step).slice(1, -1)) out.push(q)
    }
  }
  // Whatever is left over is run plain rather than left bare.
  const covered = count * pitch - gap
  if (len - covered > step) {
    const tailPts: Pt[] = []
    for (let s = covered; s <= len; s += step) tailPts.push(frameAt(s).at)
    tailPts.push(frameAt(len).at)
    for (const q of tailPts.slice(1)) out.push(q)
  }
  return dedupeStitches(out)
}

/** Resample a unit-cell polyline by a unit-space step. */
function resampleUnit(stroke: Pt[], step: number): Pt[] {
  if (step <= 0 || !isFinite(step)) return stroke
  return resample(stroke, Math.max(0.02, Math.min(1, step)))
}

function dedupeStitches(s: Stitch[], tol = 1e-6): Stitch[] {
  const out: Stitch[] = []
  for (const q of s) {
    const prev = out[out.length - 1]
    if (prev && !q.jump && !prev.jump && dist(prev, q) < tol) continue
    out.push(q)
  }
  return out
}

/**
 * Fill a region with rows of a motif.
 *
 * Rows run at the fill angle, spaced by the motif's height plus the row gap,
 * and each row is clipped to the region's spans. Only motifs that fit WHOLLY
 * inside a span are stamped: a motif cut off at the boundary is not a motif,
 * it is a mess, and the whole appeal of a motif fill is that the shapes are
 * recognisable.
 */
export function motifFill(region: Pt[][], p: FillParams, m: MotifParams): Stitch[] {
  if (!region.length || region[0].length < 3) return []
  const rad = (p.angle * Math.PI) / 180
  const cos = Math.cos(-rad), sin = Math.sin(-rad)
  const icos = Math.cos(rad), isin = Math.sin(rad)
  const rot = region.map((ring) => ring.map((q) => rotatePt(q, cos, sin)))

  let minY = Infinity, maxY = -Infinity
  for (const ring of rot) for (const q of ring) {
    if (q.y < minY) minY = q.y
    if (q.y > maxY) maxY = q.y
  }
  if (!isFinite(minY)) return []

  const h = Math.max(MIN_MOTIF_MM, m.heightMm)
  const w = Math.max(MIN_MOTIF_MM, m.widthMm)
  const rowStep = h + Math.max(0, p.spacing)
  const out: Stitch[] = []
  let leftToRight = true
  let prev: Pt | null = null

  for (let y = minY + rowStep / 2; y <= maxY; y += rowStep) {
    const spans = scanlineSpans(rot, y)
    const ordered = leftToRight ? spans : [...spans].reverse()
    for (const span of ordered) {
      const [a, b] = leftToRight ? span : [span[1], span[0]]
      const runLen = Math.abs(b - a)
      if (runLen < w) continue // no whole motif fits here
      const from = rotatePt({ x: a, y }, icos, isin)
      const to = rotatePt({ x: b, y }, icos, isin)
      const row = motifRun([from, to], { ...m, widthMm: w, heightMm: h }, { length: Math.max(0.5, p.length), style: 'plain' })
      if (!row.length) continue
      if (prev && dist(prev, row[0]) > rowStep * 1.5) out.push({ ...row[0], jump: true })
      out.push(...row)
      prev = row[row.length - 1]
    }
    leftToRight = !leftToRight
  }
  return out
}

/**
 * Sensible `spacing` and `length` for each fill style.
 *
 * The two numbers are SHARED between the styles and mean something different
 * in each: for a tatami `spacing` is row spacing at 0.4 mm, for a stipple it
 * is the meander size at 4 mm, for an echo it is the ring gap. Carrying a
 * value across a style change leaves a number that is not wrong so much as
 * meaningless — 0.4 mm of meander is not a stipple, it is a very slow fill —
 * so switching style re-bases them.
 *
 * Only the numbers whose MEANING changed are re-based; the angle, the
 * underlay and the border are left alone, because they mean the same thing
 * in every style that uses them.
 */
export const FILL_STYLE_DEFAULTS: Record<string, { spacing: number; length: number }> = {
  tatami: { spacing: 0.4, length: 4 },
  // A motif fill's spacing is the GAP between rows of motifs.
  motif: { spacing: 1.5, length: 2 },
  // A stipple's spacing is the size of the meander, not a coverage figure.
  stipple: { spacing: 4, length: 2 },
  // A cross-stitch's length is the size of one cross; spacing is unused.
  crossstitch: { spacing: 0.4, length: 3 },
  // An echo's spacing is the gap between rings.
  echo: { spacing: 1.5, length: 2 },
}

// ---------------------------------------------------------------------------
// Stipple
// ---------------------------------------------------------------------------

/**
 * A hashed pseudo-random in [0,1) from an integer.
 *
 * Deterministic on purpose. Stippling has to look unplanned, and the obvious
 * source of that is Math.random() — which would mean the same document
 * exported twice produced two different stitch files, and an approved sewout
 * said nothing about the next export. This gives the same scatter every time
 * from the same input.
 */
function hashed(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/**
 * Stipple: one wandering line covering the area loosely.
 *
 * Built on a serpentine skeleton with a WANDER applied across each row, which
 * is what turns rows into a meander. The alternative — a true random walk
 * that avoids its own path — is the textbook stipple and is both slow and
 * prone to painting itself into a corner, where it has to jump and the
 * "single continuous line" that is the whole point of stippling is lost.
 *
 * Honest about what this is: a meandering serpentine, not a self-avoiding
 * walk. At the spacing stippling is actually used (3–8 mm) the difference is
 * invisible, and the continuity is not.
 */
export function stippleFill(region: Pt[][], p: FillParams): Stitch[] {
  if (!region.length || region[0].length < 3) return []
  const rad = (p.angle * Math.PI) / 180
  const cos = Math.cos(-rad), sin = Math.sin(-rad)
  const icos = Math.cos(rad), isin = Math.sin(rad)
  const rot = region.map((ring) => ring.map((q) => rotatePt(q, cos, sin)))

  let minY = Infinity, maxY = -Infinity
  for (const ring of rot) for (const q of ring) {
    if (q.y < minY) minY = q.y
    if (q.y > maxY) maxY = q.y
  }
  if (!isFinite(minY)) return []

  // Row spacing IS the stipple scale. A stipple at fill density is not a
  // stipple, it is a very slow fill, so the spacing here is read as the
  // meander size rather than as a coverage figure.
  const step = Math.max(1.5, p.spacing)
  const length = Math.max(0.8, p.length)
  const out: Stitch[] = []
  let leftToRight = true
  let prev: Pt | null = null
  let seed = 0

  for (let y = minY + step / 2; y <= maxY; y += step) {
    const spans = scanlineSpans(rot, y)
    const ordered = leftToRight ? spans : [...spans].reverse()
    for (const span of ordered) {
      // Hold the row off the ends of its span. A penetration exactly on the
      // outline is on the boundary of the shape, not inside it, and a
      // stipple's whole character is that it does not touch the edge.
      const inset = Math.min(step / 2, Math.abs(span[1] - span[0]) / 4)
      const lo = span[0] + inset, hi = span[1] - inset
      const [a, b] = leftToRight ? [lo, hi] : [hi, lo]
      const runLen = Math.abs(b - a)
      if (runLen < step) continue
      const n = Math.max(2, Math.round(runLen / step))
      const pts: Pt[] = []
      for (let i = 0; i <= n; i++) {
        const t = i / n
        const x = a + (b - a) * t
        // Wander across the row, held to a third of the spacing so adjacent
        // rows cannot touch — touching rows would weld the meander into a
        // solid band and lose the openness that makes a stipple soft.
        const w = i === 0 || i === n ? 0 : (hashed(seed++) - 0.5) * step * 0.66
        const q = rotatePt({ x, y: y + w }, icos, isin)
        // Never place a penetration outside the shape.
        pts.push(insideRegion(region, q) ? q : rotatePt({ x, y }, icos, isin))
      }
      const walked = resample(pts, length)
      if (!walked.length) continue
      if (prev && dist(prev, walked[0]) > step * 2.5) out.push({ ...walked[0], jump: true })
      out.push(...walked)
      prev = walked[walked.length - 1]
    }
    leftToRight = !leftToRight
  }
  return out
}

// ---------------------------------------------------------------------------
// Cross-stitch
// ---------------------------------------------------------------------------

/**
 * A grid of X's.
 *
 * Counted-thread embroidery done by machine, so it is COARSE by nature: the
 * fabric showing between the crosses is the look, and a cross-stitch at fill
 * density is just an expensive fill. The grid is axis-aligned to the fill
 * angle, and a cell is stitched only when its CENTRE is inside the shape —
 * clipping a cross to the outline would produce half-crosses that read as
 * mistakes rather than as a soft edge.
 *
 * Rows serpentine, and within a row each cross is sewn as a complete X before
 * moving on, so the connecting stitch between cells runs along the row and
 * disappears under the next pass.
 */
export function crossStitchFill(region: Pt[][], p: FillParams): Stitch[] {
  if (!region.length || region[0].length < 3) return []
  const rad = (p.angle * Math.PI) / 180
  const cos = Math.cos(-rad), sin = Math.sin(-rad)
  const icos = Math.cos(rad), isin = Math.sin(rad)
  const rot = region.map((ring) => ring.map((q) => rotatePt(q, cos, sin)))

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const ring of rot) for (const q of ring) {
    if (q.x < minX) minX = q.x
    if (q.y < minY) minY = q.y
    if (q.x > maxX) maxX = q.x
    if (q.y > maxY) maxY = q.y
  }
  if (!isFinite(minX)) return []

  // The cell is the cross's size. `length` is the stitch control that means
  // "how long a stitch", and an arm of a cross IS one stitch, so that is what
  // sizes the grid.
  const cell = Math.max(1, p.length)
  const out: Stitch[] = []
  let prev: Pt | null = null
  let leftToRight = true

  for (let y = minY; y <= maxY; y += cell) {
    const cells: Pt[] = []
    for (let x = minX; x <= maxX; x += cell) {
      // Every CORNER inside, not just the centre. Testing the centre is the
      // obvious reading and it lets a cross near the edge put half its
      // thread outside the shape — stitching beyond the outline, which on a
      // garment is simply wrong however good the grid looks.
      const corners = [
        { x, y }, { x: x + cell, y }, { x, y: y + cell }, { x: x + cell, y: y + cell },
      ].map((q) => rotatePt(q, icos, isin))
      if (corners.every((q) => insideRegion(region, q))) cells.push({ x, y })
    }
    if (!cells.length) continue
    const ordered = leftToRight ? cells : [...cells].reverse()
    for (const c of ordered) {
      const h = cell / 2
      const cx = c.x + h, cy = c.y + h
      // One continuous X: down-right, back to the top-right, down-left.
      const arm = [
        { x: cx - h, y: cy - h }, { x: cx + h, y: cy + h },
        { x: cx + h, y: cy - h }, { x: cx - h, y: cy + h },
      ].map((q) => rotatePt(q, icos, isin))
      if (prev && dist(prev, arm[0]) > cell * 2.5) out.push({ ...arm[0], jump: true })
      out.push(...arm)
      prev = arm[arm.length - 1]
    }
    leftToRight = !leftToRight
  }
  return out
}

// ---------------------------------------------------------------------------
// Contour / echo
// ---------------------------------------------------------------------------

/** Most rings an echo fill will lay before giving up on a shape. */
export const MAX_ECHO_RINGS = 400

/**
 * Concentric outlines, working inwards.
 *
 * The shape's own silhouette becomes the texture. That is what separates it
 * from a tatami at the same density: a tatami's direction is chosen, an
 * echo's is given by the shape, so the texture follows a leaf or a letter
 * instead of cutting across it.
 *
 * Each ring is the previous one offset inwards, so the SPACING is honoured
 * all the way round rather than only along one axis — scanline-based fills
 * cannot do this, which is why it is a separate generator rather than an
 * option on the tatami.
 *
 * Stops when the offset collapses, which is where the shape has run out of
 * middle. The ring cap is a backstop against a pathological outline, not an
 * expected limit; reaching it is reported.
 */
/**
 * Re-start a closed ring at the vertex nearest `from`, keeping it closed.
 *
 * A ring has no natural beginning, so where it starts is free — and spending
 * that freedom on the shortest travel is the whole of contour routing.
 */
function startNear(ring: Pt[], from: Pt | null): Pt[] {
  if (!from || ring.length < 4) return ring
  // A closed ring repeats its first point last; drop it before rotating.
  const closed = dist(ring[0], ring[ring.length - 1]) < 1e-6
  const body = closed ? ring.slice(0, -1) : ring
  let best = 0, bestD = Infinity
  for (let i = 0; i < body.length; i++) {
    const d = dist(body[i], from)
    if (d < bestD) { bestD = d; best = i }
  }
  if (!closed) {
    // An open contour can only be walked from one of its two ends.
    return dist(ring[0], from) <= dist(ring[ring.length - 1], from) ? ring : [...ring].reverse()
  }
  const rotated = [...body.slice(best), ...body.slice(0, best)]
  rotated.push({ ...rotated[0] })
  return rotated
}

export function echoFill(
  region: Pt[][], p: FillParams, report?: (m: string) => void,
): Stitch[] {
  if (!region.length || region[0].length < 3) return []
  const spacing = Math.max(0.3, p.spacing)
  const length = Math.max(0.5, p.length)
  const out: Stitch[] = []
  // The first ring is inset HALF a spacing, exactly as a tatami's first row
  // sits half a row inside the shape. Sewing the outline itself would put
  // every penetration of the outermost ring on the boundary rather than
  // inside it, and leave the edge of the fill standing proud of every other
  // fill style in the program.
  const firstIn = offsetPathsChecked(region, -spacing / 2)
  if (firstIn.failed || !firstIn.paths.length) return []
  let current: Pt[][] = firstIn.paths
  let prev: Pt | null = null

  for (let k = 0; k < MAX_ECHO_RINGS; k++) {
    for (const ring of current) {
      if (ring.length < 3) continue
      // START EACH RING NEAREST WHERE THE LAST ONE ENDED.
      //
      // An offset ring begins wherever the offsetter happened to put its
      // first vertex, which bears no relation to where the previous ring
      // finished — so taking the rings as they come meant flying across the
      // shape between every pair. On a 40 mm square at 1.5 mm that was 39
      // trims for 13 rings: thirteen thread cuts, thirteen tie-offs, and a
      // minute of machine time, in a fill whose rings are 1.5 mm apart.
      //
      // Rotated to start at the nearest vertex instead, the hop inward is
      // one row spacing and sews as an ordinary stitch.
      const walked = resample(startNear(ring, prev), length)
      if (walked.length < 3) continue
      if (prev && dist(prev, walked[0]) > spacing * 3) out.push({ ...walked[0], jump: true })
      out.push(...walked)
      prev = walked[walked.length - 1]
    }
    const next = offsetPathsChecked(current, -spacing)
    if (next.failed || !next.paths.length) break
    current = next.paths
    if (k === MAX_ECHO_RINGS - 1) {
      report?.(`echo fill stopped at ${MAX_ECHO_RINGS} rings — the spacing may be far too tight for this shape`)
    }
  }
  return out
}
