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
import type { TextSpec } from './text'
import type { FrozenPlan } from './stitchedit'
import type { AngleGuide } from './satin'

export interface Pt {
  x: number
  y: number
}

/** A closed region: ring 0 is the outer boundary, any later rings are holes. */
export type Region = Pt[][]

export type StitchType =
  | 'applique' // placement, stop, tack-down, stop, finishing border
  | 'knockdown' // coarse fill laid FIRST to flatten a textured fabric
  | 'run' // single running stitch along the path
  | 'bean' // triple-pass running stitch (bold outline)
  | 'satin' // zigzag column centred on the path
  | 'fill' // tatami fill of the enclosed region
  | 'none' // construction only — generates no stitches

export interface RunParams {
  /** Nominal stitch length, mm. Machines want 1–5; 2.5 is a safe default. */
  length: number
}

export type SatinUnderlay = 'center' | 'edge' | 'zigzag'
export type FillUnderlay = 'edge' | 'zigzag'

/** The order underlay layers are sewn in, whatever order they were chosen. */
export const SATIN_UNDERLAY_ORDER: SatinUnderlay[] = ['center', 'edge', 'zigzag']
export const FILL_UNDERLAY_ORDER: FillUnderlay[] = ['edge', 'zigzag']

/** Layers of `want`, in sewing order. */
export function orderedUnderlay<T extends string>(want: readonly T[], order: readonly T[]): T[] {
  return order.filter((k) => want.includes(k))
}

export interface SatinParams {
  /** Column width, mm. Over ~10 mm the stitch is too long and snags. */
  width: number
  /** Needle-to-needle spacing along the column, mm. Lower = denser. */
  density: number
  /** Widen the column to cover the fabric pulled in by the stitch, mm. */
  pullComp: number
  /**
   * Underlay layers, applied together.
   *
   * A LIST, not one choice: real underlay is layered — a centre run to place
   * and stabilise, an edge run to support the rails, a zigzag to lift the nap
   * — and a digitizer picks the combination the fabric needs. An empty list
   * is no underlay.
   *
   * Order of application is FIXED (see UNDERLAY_ORDER), not the order they
   * were ticked: sequencing underlay is a craft convention rather than a user
   * preference, and a fixed order keeps the stitch file deterministic.
   */
  underlay: SatinUnderlay[]
  /**
   * Bar lean from perpendicular, degrees.
   *
   * Zero is ordinary satin, where every bar crosses the path at a right
   * angle. Leaning them is what produces a FAUX OVERLOCK edge: a serged edge
   * is made of slanted loops, so slanted bars read as one. Purely cosmetic
   * to the machine — the stitches are the same length and density, they just
   * land at an angle.
   */
  lean: number
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
  /** Underlay layers, applied together. Empty means none. */
  underlay: FillUnderlay[]
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
/**
 * An appliqué run: fabric laid on the garment, not thread filling a shape.
 *
 * The sequence is fixed because the machine and the operator have to take
 * turns, and the order is the whole point:
 *   placement run  — marks where the fabric goes
 *   STOP           — operator lays the fabric
 *   tack-down      — holds it while the excess is still attached
 *   STOP           — operator trims to the tack-down
 *   border         — satin covering the raw edge
 * Each phase is its own colour block, which is what produces the machine
 * stops between them: DST has no "pause" of its own, and every controller
 * treats a colour change as one.
 */
export interface AppliqueParams {
  /** Width of the tack-down zigzag, mm. Narrow — it only has to hold. */
  tackWidth: number
  tackDensity: number
  /** Width of the finishing satin that covers the cut edge, mm. */
  borderWidth: number
  borderDensity: number
  borderPullComp: number
  /** Skip the border when the edge is finished some other way. */
  border: boolean
  /**
   * 'satin' is the usual perpendicular column.
   *
   * 'overlock' leans the bars to imitate a serged edge — the finish a
   * ready-made patch has, which is what makes an appliqué read as a patch
   * rather than as fabric stitched to a shirt.
   */
  borderStyle: 'satin' | 'overlock'
}

/**
 * 3D puff: satin sewn over foam laid on the garment.
 *
 * Puff is a specialised DIGITIZING process, not a finish applied to a
 * finished file. The column has to be designed for it from the start:
 *
 *   • WIDTH has a usable band. Too narrow and the foam will not stand up
 *     under the thread; too wide and it collapses in the middle and the
 *     needle strikes the foam rather than piercing it.
 *   • DENSITY must be tighter than flat satin. Foam shows through gaps that
 *     a flat column would get away with, and it shows in white.
 *   • THE ENDS must be perforated so the excess foam TEARS CLEANLY along the
 *     stitching when it is pulled away. An un-capped end leaves foam hanging
 *     out of the design, which is the single most common puff failure.
 */
export interface PuffParams {
  enabled: boolean
  /** Foam thickness in mm — 2 and 3 are what shops stock. */
  thickness: number
  /** Multiplier on the satin density; below 1 means tighter. */
  densityScale: number
  /** Perforate the ends so the excess foam tears along the stitch line. */
  capEnds: boolean
}

/**
 * Knockdown: a coarse fill laid down BEFORE the design to flatten pile.
 *
 * On a towel, fleece or anything with a nap, embroidery sinks into the pile
 * and the fibres push back up between the stitches — the design looks furry
 * and the edges disappear. A knockdown pass mats the pile down first so the
 * real stitching sits on a flat surface.
 *
 * Two things make it a knockdown rather than just another fill:
 *   • it is COARSE. The job is to hold the pile down, not to cover anything,
 *     and a normal density here would be thousands of wasted stitches and a
 *     stiff patch of fabric.
 *   • it is BIGGER than what it supports. Pile springs back at the boundary,
 *     so a knockdown stopping exactly at the design's edge leaves a fuzzy
 *     rim around it.
 */
export interface KnockdownParams {
  /** Row spacing, mm. Far looser than a fill — this is a net, not coverage. */
  spacing: number
  /** How far beyond the outline to flatten, mm. */
  margin: number
  angle: number
  length: number
}

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
  /**
   * This object's two paths are the EDGES of one satin column, not two
   * separate columns.
   *
   * A flag rather than an inference from `paths.length === 2`: two paths is
   * also what an ordinary satin object looks like when it holds two unrelated
   * strokes, and silently welding those into one column the first time
   * someone added a second path would be an unpleasant surprise.
   */
  twoRail?: boolean
  /**
   * The typed text this object was made from, when it was.
   *
   * Kept so lettering stays EDITABLE: change the word or the face and the
   * outlines are regenerated. Without it a name becomes a pile of polygons
   * the moment it is set, and fixing a typo means deleting and retyping.
   */
  text?: TextSpec
  /**
   * Where this object should START and FINISH sewing, document mm.
   *
   * Absent means "wherever generation happens to begin", which is fine for a
   * single object and poor across a design: the travel between objects is
   * decided by where the previous one ended, so controlling the ends is how
   * a digitizer keeps jumps short and hides them under later stitching.
   */
  entry?: Pt
  exit?: Pt
  /**
   * Lines drawn ACROSS a satin column stating which way its bars should run.
   *
   * Geometry, not a parameter — they live in document mm and must be carried
   * by every transform exactly like `paths` and `shapes`, or moving an object
   * leaves its angles behind. See satin.ts for what they mean.
   *
   * Only read by the SPINE satin. A two-rail column already states its
   * directions: its rungs ARE its angle guides, so a second mechanism there
   * would be two sources of truth for one thing.
   */
  guides?: AngleGuide[]
  run: RunParams
  satin: SatinParams
  fill: FillParams
  applique: AppliqueParams
  puff: PuffParams
  knockdown: KnockdownParams
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
  /**
   * A manually edited stitch plan that has taken over from generation.
   *
   * Present only once a stitch has been edited by hand. See stitchedit.ts for
   * the rule — in short, while this exists the plan is the document's own
   * data rather than something derived, and a source edit does not silently
   * regenerate over it.
   */
  frozen?: FrozenPlan
  name: string
  hoop: Hoop
  /** The machine's bracket spacing — decides which hoops can physically mount. */
  spacing: Spacing
  objects: EmbObject[]
}

export const DEFAULT_RUN = (): RunParams => ({ length: 2.5 })

export const DEFAULT_KNOCKDOWN = (): KnockdownParams => ({
  spacing: 2,
  margin: 1.5,
  angle: 45,
  length: 4,
})

export const DEFAULT_PUFF = (): PuffParams => ({
  enabled: false,
  thickness: 3,
  // Tighter than flat satin: foam shows through gaps, and it shows in white.
  densityScale: 0.75,
  capEnds: true,
})

export const DEFAULT_APPLIQUE = (): AppliqueParams => ({
  tackWidth: 1.6,
  tackDensity: 0.6,
  borderWidth: 2.5,
  borderDensity: 0.4,
  borderPullComp: 0.2,
  border: true,
  borderStyle: 'satin',
})

export const DEFAULT_SATIN = (): SatinParams => ({
  width: 2.5,
  density: 0.4,
  pullComp: 0.2,
  underlay: ['center'],
  lean: 0,
})

export const DEFAULT_FILL = (): FillParams => ({
  angle: 45,
  spacing: 0.4,
  length: 4.0,
  stagger: 0.5,
  pullComp: 0.15,
  underlay: ['edge'],
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
    applique: DEFAULT_APPLIQUE(),
    puff: DEFAULT_PUFF(),
    knockdown: DEFAULT_KNOCKDOWN(),
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
