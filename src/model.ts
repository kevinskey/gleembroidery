// Core document model.
//
// gleEmbroidery keeps the StitchArtist mental model: the document is a list
// of VECTOR OBJECTS, each carrying a stitch type and its parameters. Stitches
// are never the document — they are regenerated from the objects on every
// change, so a parameter tweak is non-destructive. Only export flattens to
// needle penetrations.
//
// Units are millimetres throughout, Y DOWN (screen/SVG convention). The DST
// writer is the single place that flips Y and converts to 0.1 mm machine
// units; nothing above it should think in machine coordinates.

import type { Shape } from './nodes'

export interface Pt {
  x: number
  y: number
}

/** A closed region: ring 0 is the outer boundary, any later rings are holes. */
export type Region = Pt[][]

export type StitchType =
  | 'run' // single running stitch along the path
  | 'bean' // triple-pass running stitch (bold outline)
  | 'satin' // zigzag column centred on the path
  | 'fill' // tatami fill of the enclosed region
  | 'none' // construction only — generates no stitches

export interface RunParams {
  /** Nominal stitch length, mm. Machines want 1–5; 2.5 is a safe default. */
  length: number
}

export interface SatinParams {
  /** Column width, mm. Over ~10 mm the stitch is too long and snags. */
  width: number
  /** Needle-to-needle spacing along the column, mm. Lower = denser. */
  density: number
  /** Widen the column to cover the fabric pulled in by the stitch, mm. */
  pullComp: number
  underlay: 'none' | 'center' | 'edge' | 'zigzag'
}

export interface FillParams {
  /** Stitch angle in degrees, measured CCW from the +X axis. */
  angle: number
  /** Distance between fill rows, mm. 0.4 is standard commercial density. */
  spacing: number
  /** Max length of one stitch inside a row, mm. Long runs get split. */
  length: number
  /** Row-to-row shift of the split points, as a fraction of `length`. */
  stagger: number
  /** Grow the region before filling to cover pull-in, mm. */
  pullComp: number
  underlay: 'none' | 'edge' | 'zigzag' | 'double'
  /** Satin border run around the filled region after the fill. */
  border: { enabled: boolean; width: number; density: number }
}

/**
 * The spool an operator actually pulls off the rack.
 *
 * A hex colour is for the screen; it is not something anyone can look up in a
 * thread drawer. The run sheet prints whatever is here, and says UNASSIGNED
 * when nothing is — deliberately, rather than printing a hex code that reads
 * like information.
 */
export interface ThreadRef {
  brand?: string
  code?: string
  name?: string
}

export interface EmbObject {
  id: string
  name: string
  /** Display/thread colour, '#rrggbb'. Becomes a DST colour change. */
  color: string
  /** Physical thread, for the run sheet. Empty until the user assigns one. */
  thread: ThreadRef
  visible: boolean
  type: StitchType
  /**
   * Geometry in mm. For 'fill' these are read as a region (outer + holes).
   * For 'run'/'bean'/'satin' each entry is an independent path, stitched in
   * order. Closed paths repeat their first point as the last.
   */
  paths: Pt[][]
  /**
   * The EDITABLE outline, when there is one: nodes with Bézier handles.
   *
   * `paths` above is a cache re-flattened from this on every edit, and it is
   * what the whole stitch pipeline reads — nothing downstream knows shapes
   * exist. Objects made before node editing (and SVG imports) have no shapes
   * until something adopts their polyline, which is why this is optional
   * rather than the single source of truth.
   */
  shapes?: Shape[]
  run: RunParams
  satin: SatinParams
  fill: FillParams
}

/** Machine bracket spacing. A hoop's arms must match what the machine takes. */
export type Spacing = 'TJ360' | 'CH400A' | 'TJ500' | 'TJ600'

export const SPACINGS: Spacing[] = ['TJ360', 'CH400A', 'TJ500', 'TJ600']

export interface Hoop {
  name: string
  group: string
  /** Nominal size as the maker prints it, inches. This is the hoop, not the field. */
  nominalIn: [number, number]
  /** Usable sewing field, mm — nominal less the frame inset. */
  widthMm: number
  heightMm: number
  round?: boolean
  /**
   * Bracket spacing this hoop REQUIRES, where the maker states it. Undefined
   * means unstated, not unconstrained — measure before buying.
   */
  minSpacing?: Spacing
  note?: string
}

/**
 * How much smaller the sewing field is than the hoop's printed size, per side.
 *
 * A magnetic hoop's name is the frame, and the needle cannot reach the last
 * few millimetres inside it. Vendors publish this inconsistently — one lists a
 * 5.5" hoop as 5.30" inside with a 4.31–4.81" sew field — so rather than
 * invent a per-hoop figure this applies ONE conservative inset and says so.
 * Measure your own hoops and adjust; the number is deliberately in one place.
 */
export const FIELD_INSET_MM = 6

const IN = 25.4
const mh = (
  w: number, h: number, name: string,
  extra: { round?: boolean; minSpacing?: Spacing; note?: string } = {},
): Hoop => ({
  name,
  group: 'Mighty Hoop (magnetic)',
  nominalIn: [w, h],
  widthMm: Math.max(10, w * IN - 2 * FIELD_INSET_MM),
  heightMm: Math.max(10, h * IN - 2 * FIELD_INSET_MM),
  ...extra,
})

// ---------------------------------------------------------------------------
// Hoops.
//
// The Mighty Hoop list is the full BAI-compatible range as published by
// HoopMaster (hoopmaster.com/products/mighty-hoop-magnetic-embroidery-frame/bai,
// read 2026-11-12) — 26 sizes. Magnetic hoops are what a commercial shop
// actually runs, so these are the defaults rather than an afterthought.
//
// Spacing notes are quoted from that page: the 12×15, 13×16 and 10×19 need
// 600 mm spacing, and a V-22 Vision multi-head built 2024 or later may be
// limited to a CH400A bracket, where 11×13 or 12×11 is the largest that fits.
// Where the maker does not state a spacing, none is recorded here — silence
// is not permission.
// ---------------------------------------------------------------------------
const SP600 = 'Needs 600 mm bracket spacing (single-head normally reaches it).'
const SP500 = 'Largest size at TJ500 spacing — a 2024+ V-22 multi-head may cap here.'

export const HOOPS: Hoop[] = [
  // --- square / round ---
  mh(4.375, 4.375, 'Mighty Hoop 4.375" round', { round: true }),
  mh(4.25, 4.25, 'Mighty Hoop 4.25"'),
  mh(5.5, 5.5, 'Mighty Hoop 5.5"'),
  mh(6.5, 6.5, 'Mighty Hoop 6.5"'),
  mh(7.25, 7.25, 'Mighty Hoop 7.25"'),
  mh(10, 10, 'Mighty Hoop 10×10"'),

  // --- rectangular, portrait-ish ---
  mh(4, 6, 'Mighty Hoop 4×6"'),
  mh(5, 10, 'Mighty Hoop 5×10"'),
  mh(6.25, 8.25, 'Mighty Hoop 6.25×8.25"'),
  mh(8, 9, 'Mighty Hoop 8×9"'),
  mh(7.5, 11, 'Mighty Hoop 7.5×11"'),
  mh(8, 13, 'Mighty Hoop 8×13"'),
  mh(4.25, 13, 'Mighty Hoop 4.25×13"'),
  mh(11, 13, 'Mighty Hoop 11×13"', { minSpacing: 'TJ500', note: SP500 }),
  mh(12, 15, 'Mighty Hoop 12×15"', { minSpacing: 'TJ600', note: SP600 }),
  mh(13, 16, 'Mighty Hoop 13×16"', { minSpacing: 'TJ600', note: SP600 }),
  mh(10, 16, 'Mighty Hoop 10×16"'),
  mh(10, 19, 'Mighty Hoop 10×19"', { minSpacing: 'TJ600', note: SP600 }),

  // --- rectangular, landscape (wide) — left-chest, sleeves, cuffs ---
  mh(13, 8, 'Mighty Hoop 13×8"'),
  mh(13, 4.25, 'Mighty Hoop 4.25×13" horizontal'),
  mh(9, 3, 'Mighty Hoop 9×3"'),
  mh(9, 4.25, 'Mighty Hoop 9×4.25"'),
  mh(9, 5, 'Mighty Hoop 9×5"'),
  mh(9, 6, 'Mighty Hoop 9×6"'),
  mh(12, 3.25, 'Mighty Hoop 12×3.25"'),
  mh(12, 11, 'Mighty Hoop 12×11"', { minSpacing: 'TJ500', note: SP500 }),

  // --- conventional screw hoops and cap frames ---
  { name: 'Tubular 4" round', group: 'Standard', nominalIn: [4, 4], widthMm: 100, heightMm: 100, round: true },
  { name: 'Tubular 5×7"', group: 'Standard', nominalIn: [5, 7], widthMm: 130, heightMm: 180 },
  { name: 'Tubular 6×10"', group: 'Standard', nominalIn: [6, 10], widthMm: 160, heightMm: 260 },
  { name: 'Tubular 8×8"', group: 'Standard', nominalIn: [8, 8], widthMm: 200, heightMm: 200 },
  {
    name: 'Cap frame — wide (360×75 mm)', group: 'Cap frames', nominalIn: [14.2, 3],
    widthMm: 360, heightMm: 75,
    note: 'Sew bottom-up and centre-out; the curve fights you at the edges.',
  },
  {
    name: 'Cap frame — standard (270×60 mm)', group: 'Cap frames', nominalIn: [10.6, 2.4],
    widthMm: 270, heightMm: 60,
    note: 'Sew bottom-up and centre-out; the curve fights you at the edges.',
  },
]

/** Hoops that physically mount on a machine with the given bracket spacing. */
export function hoopsForSpacing(spacing: Spacing): Hoop[] {
  const rank: Record<Spacing, number> = { TJ360: 0, CH400A: 1, TJ500: 2, TJ600: 3 }
  return HOOPS.filter((h) => !h.minSpacing || rank[h.minSpacing] <= rank[spacing])
}

export interface Doc {
  name: string
  hoop: Hoop
  /** The machine's bracket spacing — decides which hoops can physically mount. */
  spacing: Spacing
  objects: EmbObject[]
}

export const DEFAULT_RUN = (): RunParams => ({ length: 2.5 })

export const DEFAULT_SATIN = (): SatinParams => ({
  width: 2.5,
  density: 0.4,
  pullComp: 0.2,
  underlay: 'center',
})

export const DEFAULT_FILL = (): FillParams => ({
  angle: 45,
  spacing: 0.4,
  length: 4.0,
  stagger: 0.5,
  pullComp: 0.15,
  underlay: 'edge',
  border: { enabled: false, width: 2.0, density: 0.4 },
})

let seq = 0

/**
 * Teach the id generator about ids that already exist (a reopened project).
 * Without this, loading a file with `o1..o9` and then adding an object mints
 * `o1` again, and every edit addressed by id hits the wrong one.
 */
export function registerExistingIds(ids: readonly string[]): void {
  for (const id of ids) {
    const m = /^o(\d+)$/.exec(id)
    if (m) seq = Math.max(seq, parseInt(m[1], 10))
  }
}

export function newObject(partial: Partial<EmbObject> = {}): EmbObject {
  return {
    id: `o${++seq}`,
    name: partial.name ?? `Object ${seq}`,
    color: partial.color ?? '#1f6feb',
    thread: partial.thread ?? {},
    visible: true,
    type: partial.type ?? 'fill',
    paths: partial.paths ?? [],
    run: DEFAULT_RUN(),
    satin: DEFAULT_SATIN(),
    fill: DEFAULT_FILL(),
    ...partial,
  }
}

export const DEFAULT_HOOP =
  HOOPS.find((h) => h.name === 'Mighty Hoop 8×9"') ?? HOOPS[0]

export function emptyDoc(): Doc {
  // 8×9" covers left-chest and most full-front work, and mounts on every
  // bracket spacing — the hoop a shop reaches for without thinking.
  return { name: 'untitled', hoop: DEFAULT_HOOP, spacing: 'TJ500', objects: [] }
}

export function bounds(paths: Pt[][]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of paths) for (const q of p) {
    if (q.x < minX) minX = q.x
    if (q.y < minY) minY = q.y
    if (q.x > maxX) maxX = q.x
    if (q.y > maxY) maxY = q.y
  }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : null
}
