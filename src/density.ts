// Density analysis: where a design puts too much thread in one place.
//
// This is the diagnostic that matters most on a real machine. Over-dense
// patches are where needles break, thread shreds, and the fabric puckers or
// tears — and they are invisible in a preview, because a dense area and a
// correct one look identical once the colour is solid. They only show up as
// a number.
//
// Counted as PENETRATIONS PER SQUARE MILLIMETRE on a fixed grid, because that
// is what the needle and the fabric actually experience. Stitch length and
// row spacing are the settings; penetrations per unit area is the consequence,
// and two sensible-looking settings can still collide where objects overlap.
//
// Pure and DOM-free: it takes a stitch plan, so the suite covers it.

import type { StitchPlan } from './stitches'
import type { Pt } from './model'

/**
 * Grid cell size, mm.
 *
 * Must be at least a full stitch LENGTH, or the measurement reports an
 * artefact of its own grid. A correct fill at 0.4 mm rows and 4 mm stitches
 * puts its penetrations 4 mm apart along each row — measured on a 2 mm grid
 * every other cell is empty and the occupied ones read 2x nominal, which
 * would flag every well-built fill in the design as a fault.
 *
 * 4 mm is the default max stitch length, so a cell always contains a whole
 * stitch's worth of spacing. The cost is that a dense patch smaller than
 * 4 mm is averaged with its surroundings; that is the right trade, because a
 * false alarm on every fill would make the whole diagnostic ignorable.
 */
export const CELL_MM = 4

/**
 * Penetrations per mm² that a normal commercial fill produces.
 *
 * A 0.4 mm row spacing with a 4 mm stitch length puts a penetration roughly
 * every 0.4 x 4 mm, which is 1 / 1.6 = 0.625 per mm². Everything here is
 * judged as a multiple of that, so the thresholds mean something physical
 * rather than being numbers someone liked.
 */
export const NOMINAL_PER_MM2 = 0.625

/**
 * Thresholds, placed around the faults they are meant to catch rather than
 * at round numbers.
 *
 * Two standard fills overlapping is 2.0x nominal, and that is THE canonical
 * digitizing fault — so the warning sits below it at 1.8, with enough margin
 * above a correct single fill (which measures 1.0 to 1.1) not to cry wolf.
 * Three layers is 3.0x, so severe sits below that at 2.8.
 */
export const WARN_RATIO = 1.8
/** Above this, expect thread breaks and needle strikes. */
export const SEVERE_RATIO = 2.8

export interface DensityCell {
  /** Cell's lower-left corner in document mm. */
  x: number
  y: number
  count: number
  perMm2: number
  /** Multiple of a normal commercial fill. */
  ratio: number
}

export interface DensityReport {
  cells: DensityCell[]
  /** Only the cells at or past WARN_RATIO, worst first. */
  hotspots: DensityCell[]
  worst: number
  /** Total penetrations counted — excludes jumps, which pierce nothing. */
  penetrations: number
  warnings: string[]
}

/**
 * Count penetrations per grid cell across the whole plan.
 *
 * Jumps are excluded: a jump is a travel move with the needle up, and
 * counting it as thread in the fabric would flag empty space as dense.
 *
 * Cells are counted across ALL colour blocks together, because the fabric
 * does not care which needle made the hole — an overlap between two colours
 * is exactly the case a per-object check would miss.
 */
export function analyseDensity(plan: StitchPlan, cellMm = CELL_MM): DensityReport {
  const warnings: string[] = []
  const cell = Math.max(0.5, cellMm)
  const counts = new Map<string, { x: number; y: number; n: number }>()
  let penetrations = 0

  for (const b of plan.blocks) {
    for (const s of b.stitches) {
      if (s.jump) continue
      penetrations++
      const gx = Math.floor(s.x / cell)
      const gy = Math.floor(s.y / cell)
      const k = `${gx},${gy}`
      const c = counts.get(k)
      if (c) c.n++
      else counts.set(k, { x: gx * cell, y: gy * cell, n: 1 })
    }
  }

  // Evaluate each cell over its 3x3 NEIGHBOURHOOD rather than alone.
  //
  // A single cell is still an arbitrary box drawn over a regular stitch
  // pattern: a 4 mm cell on 4 mm stitch spacing catches one column of
  // penetrations or two depending on where its edge falls, so an evenly
  // over-dense patch comes out as a chequerboard of alternating cells. That
  // is the grid talking, not the design.
  //
  // A window over the neighbourhood averages that out while keeping real
  // hotspots — and matches the physics better anyway, since fabric
  // distributes the stress of a dense patch over the area around it rather
  // than tearing at one 4 mm square.
  //
  // EMPTY neighbours are left out of the average. Unstitched space is not
  // "low density" to be averaged in, it is absence — counting it would let a
  // small, genuinely over-dense patch hide behind the blank fabric around it,
  // which is exactly the fault most worth catching.
  const raw = new Map<string, number>()
  for (const [k, c] of counts) raw.set(k, c.n)
  const area = cell * cell
  const cells: DensityCell[] = []
  for (const c of counts.values()) {
    const gx = Math.round(c.x / cell), gy = Math.round(c.y / cell)
    let sum = 0, n = 0
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const v = raw.get(`${gx + dx},${gy + dy}`)
        if (v === undefined) continue
        sum += v
        n++
      }
    }
    const perMm2 = sum / (area * Math.max(1, n))
    cells.push({ x: c.x, y: c.y, count: c.n, perMm2, ratio: perMm2 / NOMINAL_PER_MM2 })
  }
  cells.sort((a, b) => b.ratio - a.ratio)

  const hotspots = cells.filter((c) => c.ratio >= WARN_RATIO)
  const worst = cells.length ? cells[0].ratio : 0
  const severe = hotspots.filter((c) => c.ratio >= SEVERE_RATIO).length
  if (severe) {
    warnings.push(
      `${severe} area${severe === 1 ? '' : 's'} over ${SEVERE_RATIO}x normal density — expect thread breaks; reduce density or remove an overlap`)
  } else if (hotspots.length) {
    warnings.push(
      `${hotspots.length} area${hotspots.length === 1 ? '' : 's'} over ${WARN_RATIO}x normal density — check for overlapping objects`)
  }
  return { cells, hotspots, worst, penetrations, warnings }
}

/** Colour for a density ratio, for the heat overlay. */
export function densityColour(ratio: number): string | null {
  if (ratio < WARN_RATIO) return null
  if (ratio >= SEVERE_RATIO) return 'rgba(220,38,38,0.55)'
  return 'rgba(245,158,11,0.45)'
}

/** Centre of a cell, for pointing the user at it. */
export function cellCentre(c: DensityCell, cellMm = CELL_MM): Pt {
  return { x: c.x + cellMm / 2, y: c.y + cellMm / 2 }
}
