// Reusable stitch styles.
//
// A shop sews the same handful of things over and over: a left-chest logo
// fill, a cap satin that has to survive a curved frame, a knockdown for
// towels, lettering small enough that the usual satin settings refuse it.
// Each of those is a dozen numbers that took someone an afternoon and a
// sewout to arrive at, and today they live in whichever project file they
// were last typed into.
//
// A preset is that bundle of numbers, named, and reusable across documents.
//
// WHAT A PRESET IS NOT. It carries no geometry, no name, no colour, no
// thread, no entry/exit, no angle guides. Applying one to an object changes
// HOW IT IS SEWN and nothing else — if it could move the shape or repaint it,
// nobody could apply one to finished artwork without checking afterwards what
// else had happened, which defeats the point.
//
// Pure and DOM-free: storage is the caller's problem, and the parse/serialise
// pair here is the same shape as project.ts's so a corrupt store degrades to
// "no presets" rather than to a half-read one.

import {
  DEFAULT_APPLIQUE, DEFAULT_FILL, DEFAULT_KNOCKDOWN, DEFAULT_PUFF, DEFAULT_RUN,
  DEFAULT_SATIN,
  type AppliqueParams, type EmbObject, type FillParams, type KnockdownParams,
  type PuffParams, type RunParams, type SatinParams, type StitchType,
} from './model'
import { DEFAULT_MOTIF, type MotifParams } from './decorative'

/** Everything about how an object is sewn, and nothing about what it is. */
export interface StyleBody {
  type: StitchType
  run: RunParams
  satin: SatinParams
  fill: FillParams
  applique: AppliqueParams
  puff: PuffParams
  knockdown: KnockdownParams
  motif: MotifParams
}

export interface StylePreset extends StyleBody {
  id: string
  name: string
  /** Why it exists and when to reach for it. Shown as the tooltip. */
  note?: string
  /** Shipped with the program, so it cannot be deleted or overwritten. */
  builtIn?: boolean
}

/**
 * Lift the stitch settings off an object.
 *
 * Deep-copied. Sharing the parameter objects would make a preset a live
 * window onto whichever object it was made from — edit that object and every
 * future application of the preset would quietly change too.
 */
export function extractStyle(o: EmbObject): StyleBody {
  return {
    type: o.type,
    run: { ...o.run },
    satin: { ...o.satin, underlay: [...o.satin.underlay], split: { ...o.satin.split } },
    fill: { ...o.fill, underlay: [...o.fill.underlay], border: { ...o.fill.border } },
    applique: { ...o.applique },
    puff: { ...o.puff },
    knockdown: { ...o.knockdown },
    motif: { ...o.motif },
  }
}

/**
 * Apply a style to an object.
 *
 * ALL the parameter blocks are replaced, not just the one matching the
 * preset's stitch type. A preset for a satin that left the fill settings
 * alone would behave differently depending on what the object was before it,
 * which is the kind of thing that is impossible to debug from the result.
 */
export function applyStyle(o: EmbObject, s: StyleBody): EmbObject {
  const body = extractStyle({ ...o, ...s } as EmbObject)
  return { ...o, ...body }
}

/** A style the object already has, for deciding whether to show it as active. */
export function sameStyle(a: StyleBody, b: StyleBody): boolean {
  return JSON.stringify(extractStyle(a as EmbObject)) === JSON.stringify(extractStyle(b as EmbObject))
}

const base = (): StyleBody => ({
  type: 'fill',
  run: DEFAULT_RUN(),
  satin: DEFAULT_SATIN(),
  fill: DEFAULT_FILL(),
  applique: DEFAULT_APPLIQUE(),
  puff: DEFAULT_PUFF(),
  knockdown: DEFAULT_KNOCKDOWN(),
  motif: DEFAULT_MOTIF(),
})

/**
 * The presets that ship with the program.
 *
 * These are STARTING POINTS, not settled truth. The numbers are the ordinary
 * commercial values for each job and every one of them should be adjusted
 * against a sewout on the fabric actually being used — which is why each
 * carries a note saying what it assumes rather than presenting itself as
 * correct.
 */
export const BUILT_IN_PRESETS: StylePreset[] = [
  {
    ...base(),
    id: 'builtin:logo-fill', name: 'Left-chest logo fill', builtIn: true,
    note: 'Standard commercial fill on woven shirting: 0.4 mm rows, edge underlay, '
      + 'a little pull compensation. The everyday starting point.',
    type: 'fill',
    fill: { ...DEFAULT_FILL(), spacing: 0.4, length: 4, stagger: 0.5, pullComp: 0.15, underlay: ['edge'] },
  },
  {
    ...base(),
    id: 'builtin:knit-fill', name: 'Fill for knits', builtIn: true,
    note: 'Looser rows and BOTH underlays, because a knit moves under the needle. '
      + 'More pull compensation: jersey draws in further than woven cloth.',
    type: 'fill',
    fill: { ...DEFAULT_FILL(), spacing: 0.45, length: 3.5, stagger: 0.5, pullComp: 0.3, underlay: ['edge', 'zigzag'] },
  },
  {
    ...base(),
    id: 'builtin:lettering-satin', name: 'Satin lettering', builtIn: true,
    note: 'Tight satin with a centre run under it, for letters around 6–10 mm. '
      + 'Below about 5 mm cap height, switch to a bean run — a satin that narrow '
      + 'is refused, and rightly.',
    type: 'satin',
    satin: { ...DEFAULT_SATIN(), width: 2, density: 0.35, pullComp: 0.2, underlay: ['center'] },
  },
  {
    ...base(),
    id: 'builtin:cap-satin', name: 'Cap satin', builtIn: true,
    note: 'Wider and denser, with centre and zigzag underlay. A cap frame holds the '
      + 'fabric on a curve and fights the needle at the edges; sew bottom-up and '
      + 'centre-out.',
    type: 'satin',
    satin: { ...DEFAULT_SATIN(), width: 3.5, density: 0.35, pullComp: 0.3, underlay: ['center', 'zigzag'] },
  },
  {
    ...base(),
    id: 'builtin:puff-satin', name: '3D puff satin', builtIn: true,
    note: 'For 3 mm foam. Wide enough for the foam to stand up, dense enough that it '
      + 'does not show white through the thread, with the ends perforated so the '
      + 'excess tears along the stitching.',
    type: 'satin',
    satin: { ...DEFAULT_SATIN(), width: 6, density: 0.4, pullComp: 0.35, underlay: ['center'] },
    puff: { enabled: true, thickness: 3, densityScale: 0.75, capEnds: true },
  },
  {
    ...base(),
    id: 'builtin:towel-knockdown', name: 'Towel knockdown', builtIn: true,
    note: 'A coarse net to flatten pile before the design goes on. Put it FIRST in '
      + 'the sewing sequence; 2 mm of margin so the pile does not spring back '
      + 'around the edge.',
    type: 'knockdown',
    knockdown: { spacing: 2, margin: 2, angle: 45, length: 4 },
  },
  {
    ...base(),
    id: 'builtin:applique-patch', name: 'Appliqué patch edge', builtIn: true,
    note: 'Placement, stop, tack-down, stop, then a faux overlock border — the finish '
      + 'that makes an appliqué read as a ready-made patch rather than as fabric '
      + 'stitched to a shirt.',
    type: 'applique',
    applique: { ...DEFAULT_APPLIQUE(), borderWidth: 3, borderStyle: 'overlock' },
  },
  {
    ...base(),
    id: 'builtin:background-stipple', name: 'Background stipple', builtIn: true,
    note: 'A loose wandering line to soften a background without stiffening it. '
      + 'About a seventh of the stitches of a fill over the same area.',
    type: 'fill',
    fill: { ...DEFAULT_FILL(), style: 'stipple', spacing: 4, length: 2, underlay: [] },
  },
  {
    ...base(),
    id: 'builtin:outline-bean', name: 'Bean outline', builtIn: true,
    note: 'Triple-pass run for an outline that has to hold its own — and the right '
      + 'answer wherever a satin would be under about 1 mm wide.',
    type: 'bean',
    run: { length: 2, style: 'plain' },
  },
]

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export const PRESETS_KEY = 'gleembroidery.presets.v1'

export function serializePresets(list: readonly StylePreset[]): string {
  // Built-ins are not stored: they ship with the program, and a copy saved
  // today would go stale the moment one of them is improved.
  return JSON.stringify(list.filter((p) => !p.builtIn))
}

/**
 * Read saved presets, dropping anything malformed.
 *
 * Field by field against the defaults, exactly as a project file is read. A
 * preset with a missing number must not apply a NaN to an object's density —
 * the stitch plan that came out of that would be a mystery to debug and a
 * mess to sew.
 */
export function parsePresets(text: string | null): StylePreset[] {
  if (!text) return []
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return [] }
  if (!Array.isArray(raw)) return []
  const out: StylePreset[] = []
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    if (typeof o.id !== 'string' || typeof o.name !== 'string') continue
    const d = base()
    // Compensation may legitimately be absent from a preset, meaning the
    // object keeps following the document. See CompDefaults.
    const optNum = (x: unknown) =>
      (typeof x === 'number' && Number.isFinite(x) ? x : undefined)
    const num = (x: unknown, fb: number) =>
      typeof x === 'number' && isFinite(x) ? x : fb
    const sub = (k: string) => (o[k] && typeof o[k] === 'object' ? o[k] as Record<string, unknown> : {})
    const r = sub('run'), sa = sub('satin'), f = sub('fill')
    const ap = sub('applique'), pu = sub('puff'), kd = sub('knockdown'), mo = sub('motif')
    const sp = sa.split && typeof sa.split === 'object' ? sa.split as Record<string, unknown> : {}
    const bd = f.border && typeof f.border === 'object' ? f.border as Record<string, unknown> : {}
    out.push({
      id: o.id,
      name: o.name,
      note: typeof o.note === 'string' ? o.note : undefined,
      type: typeof o.type === 'string'
        ? (o.type as StitchType) : d.type,
      run: {
        length: num(r.length, d.run.length),
        style: r.style === 'motif' ? 'motif' : 'plain',
      },
      satin: {
        width: num(sa.width, d.satin.width),
        density: num(sa.density, d.satin.density),
        // A preset may legitimately say nothing about compensation, which
        // means the object keeps following the document. See CompDefaults.
        pullComp: optNum(sa.pullComp),
        pushComp: optNum(sa.pushComp),
        underlay: Array.isArray(sa.underlay)
          ? (sa.underlay.filter((u) => u === 'center' || u === 'edge' || u === 'zigzag') as SatinParams['underlay'])
          : d.satin.underlay,
        lean: num(sa.lean, d.satin.lean),
        split: {
          enabled: sp.enabled === true,
          maxLength: num(sp.maxLength, d.satin.split.maxLength),
          stagger: num(sp.stagger, d.satin.split.stagger),
        },
      },
      fill: {
        style: (['tatami', 'motif', 'stipple', 'crossstitch', 'echo'] as const)
          .includes(f.style as never) ? f.style as FillParams['style'] : d.fill.style,
        angle: num(f.angle, d.fill.angle),
        spacing: num(f.spacing, d.fill.spacing),
        length: num(f.length, d.fill.length),
        stagger: num(f.stagger, d.fill.stagger),
        pullComp: optNum(f.pullComp),
        pushComp: optNum(f.pushComp),
        underlay: Array.isArray(f.underlay)
          ? (f.underlay.filter((u) => u === 'edge' || u === 'zigzag') as FillParams['underlay'])
          : d.fill.underlay,
        border: {
          enabled: bd.enabled === true,
          width: num(bd.width, d.fill.border.width),
          density: num(bd.density, d.fill.border.density),
        },
      },
      applique: {
        tackWidth: num(ap.tackWidth, d.applique.tackWidth),
        tackDensity: num(ap.tackDensity, d.applique.tackDensity),
        borderWidth: num(ap.borderWidth, d.applique.borderWidth),
        borderDensity: num(ap.borderDensity, d.applique.borderDensity),
        borderPullComp: num(ap.borderPullComp, d.applique.borderPullComp),
        border: ap.border !== false,
        borderStyle: ap.borderStyle === 'overlock' ? 'overlock' : 'satin',
      },
      puff: {
        enabled: pu.enabled === true,
        thickness: num(pu.thickness, d.puff.thickness),
        densityScale: num(pu.densityScale, d.puff.densityScale),
        capEnds: pu.capEnds !== false,
      },
      knockdown: {
        spacing: num(kd.spacing, d.knockdown.spacing),
        margin: num(kd.margin, d.knockdown.margin),
        angle: num(kd.angle, d.knockdown.angle),
        length: num(kd.length, d.knockdown.length),
      },
      motif: {
        id: typeof mo.id === 'string' ? mo.id : d.motif.id,
        widthMm: num(mo.widthMm, d.motif.widthMm),
        heightMm: num(mo.heightMm, d.motif.heightMm),
        gapMm: num(mo.gapMm, d.motif.gapMm),
      },
    })
  }
  return out
}

let seq = 0

/** Make a preset from an object's current settings. */
export function presetFrom(o: EmbObject, name: string): StylePreset {
  return { id: `p${Date.now().toString(36)}${++seq}`, name, ...extractStyle(o) }
}
