// Native project files: save and reopen an EDITABLE document.
//
// A rendered preview is not a project (spec §3). What is written here is the
// object model — outlines, stitch types, every parameter — so reopening gives
// back something you can still change, and re-digitising reproduces the same
// plan exactly. The machine export (.dst) is a separate, derived artefact and
// is never what gets saved here.
//
// VERSIONING IS AN EXPLICIT GATE, NOT DUCK-TYPING.
//
// StoneCut writes a `v: 1` into its rhinestone files and then reads it
// nowhere — both of its loaders sniff for fields instead. The consequence is
// that an older build opening a newer file silently drops whatever it did not
// recognise and writes the loss back on the next save. That failure mode is
// designed out here: a file states its version, a build states the highest
// version it understands, and anything newer is REFUSED with a message rather
// than partially read.

import type { PathNode, Shape } from './nodes'
import type { AngleGuide } from './satin'
import type { FrozenPlan } from './stitchedit'
import type { Stitch } from './stitches'
import {
  DEFAULT_APPLIQUE,
  DEFAULT_FILL,
  DEFAULT_KNOCKDOWN,
  DEFAULT_PUFF,
  DEFAULT_RUN,
  DEFAULT_SATIN,
  HOOPS,
  SPACINGS,
  emptyDoc,
  registerExistingIds,
  type Doc,
  type EmbObject,
  type Hoop,
  type Pt,
  type FillUnderlay,
  type SatinUnderlay,
  FILL_UNDERLAY_ORDER,
  SATIN_UNDERLAY_ORDER,
  orderedUnderlay,

  type StitchType,
} from './model'

/** Bump ONLY with a matching entry in MIGRATIONS below. */
export const SCHEMA_VERSION = 1

export const FILE_FORMAT = 'gleembroidery-project'
export const FILE_EXT = 'gleemb'

export interface ProjectFile {
  format: typeof FILE_FORMAT
  version: number
  /** Informational only — never used to decide how to read the file. */
  savedAt?: string
  app?: string
  doc: unknown
}

export class ProjectError extends Error {}

const STITCH_TYPES: StitchType[] = ['run', 'bean', 'satin', 'fill', 'none']

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Hoops are stored by value as well as by name. A preset can be renamed or
 * dropped between builds, and a design's physical size must not depend on
 * that — the name is a convenience, the millimetres are the truth.
 */
function hoopOut(h: Hoop) {
  return {
    name: h.name,
    group: h.group,
    nominalIn: h.nominalIn,
    widthMm: h.widthMm,
    heightMm: h.heightMm,
    round: h.round,
    minSpacing: h.minSpacing,
    note: h.note,
  }
}

/**
 * The geometry keys of a saved object.
 *
 * Split out because the SIGNATURE folds coordinates numerically — stringifying
 * 20k points costs ~10 ms on every render, which is a dropped frame on every
 * mouse move of a drag. Everything NOT listed here is a setting, and settings
 * are hashed wholesale so no new one can be forgotten. SIGNATURE_GEOMETRY_KEYS
 * is checked against the real output by the suite, so adding a geometry field
 * without listing it here fails a test rather than silently going unhashed.
 */
export const SIGNATURE_GEOMETRY_KEYS = ['paths', 'shapes', 'guides'] as const

export function objectOut(o: EmbObject) {
  return {
    id: o.id,
    name: o.name,
    color: o.color,
    thread: { ...o.thread },
    visible: o.visible,
    type: o.type,
    // Full precision on purpose: rounding here would make a reopened project
    // generate a subtly different plan from the one that was approved.
    paths: o.paths.map((p) => p.map((q) => [q.x, q.y])),
    ...(o.entry ? { entry: [o.entry.x, o.entry.y] } : {}),
    ...(o.exit ? { exit: [o.exit.x, o.exit.y] } : {}),
    ...(o.guides?.length
      ? { guides: o.guides.map((g) => [g.a.x, g.a.y, g.b.x, g.b.y]) }
      : {}),
    applique: { ...o.applique },
    puff: { ...o.puff },
    knockdown: { ...o.knockdown },
    ...(o.twoRail ? { twoRail: true } : {}),
    ...(o.text ? { text: { ...o.text } } : {}),
    // The editable outline rides alongside the flattened cache. Without it a
    // reopened project could be sewn but never shaped again.
    shapes: o.shapes?.map((sh) => ({
      closed: sh.closed,
      nodes: sh.nodes.map((n) => ({
        x: n.x, y: n.y,
        ...(n.hIn ? { hIn: [n.hIn.x, n.hIn.y] } : {}),
        ...(n.hOut ? { hOut: [n.hOut.x, n.hOut.y] } : {}),
        ...(n.smooth ? { smooth: true } : {}),
      })),
    })),
    run: { ...o.run },
    satin: { ...o.satin },
    fill: { ...o.fill, border: { ...o.fill.border } },
  }
}

export function serialize(doc: Doc, pretty = false): string {
  const file: ProjectFile = {
    format: FILE_FORMAT,
    version: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    app: 'gleEmbroidery',
    doc: {
      name: doc.name,
      hoop: hoopOut(doc.hoop),
      spacing: doc.spacing,
      objects: doc.objects.map(objectOut),
      // Manual stitch edits ARE the document once they exist. A project that
      // reopened without them would lose work with no way to get it back,
      // which is the exact failure the freeze model is there to prevent.
      ...(doc.frozen ? {
        frozen: {
          signature: doc.frozen.signature,
          edits: doc.frozen.edits,
          blocks: doc.frozen.plan.blocks.map((b) => ({
            color: b.color,
            label: b.label,
            // Flags are only written when set, which keeps a 40k-stitch plan
            // from tripling in size for fields that are almost always absent.
            stitches: b.stitches.map((st) => [
              st.x, st.y,
              (st.jump ? 1 : 0) | (st.trim ? 2 : 0) | (st.lock ? 4 : 0),
            ]),
          })),
        },
      } : {}),
    },
  }
  return JSON.stringify(file, null, pretty ? 1 : 0)
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

function pathsIn(v: unknown): Pt[][] {
  if (!Array.isArray(v)) return []
  const out: Pt[][] = []
  for (const path of v) {
    if (!Array.isArray(path)) continue
    const pts: Pt[] = []
    for (const q of path) {
      if (Array.isArray(q) && typeof q[0] === 'number' && typeof q[1] === 'number') {
        pts.push({ x: q[0], y: q[1] })
      } else if (isObj(q) && typeof q.x === 'number' && typeof q.y === 'number') {
        pts.push({ x: q.x, y: q.y })
      }
    }
    if (pts.length) out.push(pts)
  }
  return out
}

function hoopIn(v: unknown): Hoop {
  const d = emptyDoc().hoop
  if (!isObj(v)) return d
  const name = str(v.name, d.name)
  const w = num(v.widthMm, NaN)
  const h = num(v.heightMm, NaN)
  // A preset match keeps notes and spacing rules current; a stored size that
  // disagrees with the preset still wins, because that is what the design was
  // built against.
  const preset = HOOPS.find((x) => x.name === name)
  if (preset && (!Number.isFinite(w) || Math.abs(preset.widthMm - w) < 1e-6)) return preset
  if (!Number.isFinite(w) || !Number.isFinite(h)) return preset ?? d
  const ni = Array.isArray(v.nominalIn) && v.nominalIn.length === 2
    ? [num(v.nominalIn[0], w / 25.4), num(v.nominalIn[1], h / 25.4)] as [number, number]
    : [w / 25.4, h / 25.4] as [number, number]
  return {
    name,
    group: str(v.group, 'Saved with the project'),
    nominalIn: ni,
    widthMm: w,
    heightMm: h,
    round: v.round === true,
    minSpacing: typeof v.minSpacing === 'string'
      ? oneOf(v.minSpacing, SPACINGS, 'TJ500')
      : undefined,
    note: typeof v.note === 'string' ? v.note : undefined,
  }
}

/** Read editable outlines. Anything malformed is dropped, not guessed at —
 *  the object still has its flattened `paths` and stays sewable. */
/**
 * Read a frozen plan.
 *
 * Anything malformed yields undefined, which drops the document back to
 * generating. That is the safe direction: a design that regenerates is
 * correct but has lost hand edits, whereas a half-read stitch list would sew.
 */
function frozenIn(v: unknown): FrozenPlan | undefined {
  if (!isObj(v) || !Array.isArray(v.blocks) || typeof v.signature !== 'string') return undefined
  const blocks = []
  for (const b of v.blocks) {
    if (!isObj(b) || !Array.isArray(b.stitches)) continue
    const stitches: Stitch[] = []
    for (const st of b.stitches) {
      if (!Array.isArray(st) || typeof st[0] !== 'number' || typeof st[1] !== 'number') continue
      const f = typeof st[2] === 'number' ? st[2] : 0
      stitches.push({
        x: st[0], y: st[1],
        ...(f & 1 ? { jump: true } : {}),
        ...(f & 2 ? { trim: true } : {}),
        ...(f & 4 ? { lock: true } : {}),
      })
    }
    if (stitches.length) {
      blocks.push({
        color: /^#[0-9a-fA-F]{6}$/.test(String(b.color)) ? String(b.color) : '#1f6feb',
        label: str(b.label, 'block'),
        stitches,
      })
    }
  }
  if (!blocks.length) return undefined
  return { plan: { blocks }, signature: v.signature, edits: num(v.edits, 0) }
}

/** A stored [x, y] pair, or undefined when absent or malformed. */
function ptIn(v: unknown): Pt | undefined {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number'
    ? { x: v[0], y: v[1] } : undefined
}

/**
 * Angle guides, stored flat as [ax, ay, bx, by].
 *
 * A guide whose numbers are not all there is DROPPED rather than repaired: a
 * half-read guide would still turn the bars, just not where anyone put it,
 * and a column with no guides sews correctly.
 */
function guidesIn(v: unknown): AngleGuide[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: AngleGuide[] = []
  for (const g of v) {
    if (!Array.isArray(g) || g.length !== 4) continue
    if (!g.every((n) => typeof n === 'number' && isFinite(n))) continue
    out.push({ a: { x: g[0], y: g[1] }, b: { x: g[2], y: g[3] } })
  }
  return out.length ? out : undefined
}

function shapesIn(v: unknown): Shape[] | undefined {
  if (!Array.isArray(v)) return undefined
  const pt = (q: unknown): Pt | undefined =>
    Array.isArray(q) && q.length === 2 && typeof q[0] === 'number' && typeof q[1] === 'number'
      ? { x: q[0], y: q[1] } : undefined
  const out: Shape[] = []
  for (const sh of v) {
    if (!isObj(sh) || !Array.isArray(sh.nodes)) continue
    const nodes: PathNode[] = []
    for (const n of sh.nodes) {
      if (!isObj(n) || typeof n.x !== 'number' || typeof n.y !== 'number') continue
      nodes.push({
        x: n.x, y: n.y,
        hIn: pt(n.hIn), hOut: pt(n.hOut),
        ...(n.smooth === true ? { smooth: true } : {}),
      })
    }
    if (nodes.length >= 2) out.push({ nodes, closed: sh.closed === true })
  }
  return out.length ? out : undefined
}

/**
 * Read an underlay selection.
 *
 * Projects saved before underlay became a LIST hold a single string, and the
 * fill's "double" was already the edge+zigzag combination under another name.
 * Migrating on read rather than bumping the schema keeps every existing file
 * openable — and an unreadable value falls back to the default rather than to
 * nothing, because silently sewing a column with NO underlay is a wearable
 * defect, not a cosmetic one.
 */
function underlayIn<T extends string>(
  v: unknown, order: readonly T[], legacy: Record<string, T[]>, fallback: T[],
): T[] {
  if (Array.isArray(v)) {
    const want = v.filter((k): k is T => order.includes(k as T))
    // An explicit empty list means the user chose "no underlay" — honour it.
    return orderedUnderlay(want, order)
  }
  if (typeof v === 'string') {
    if (v === 'none') return []
    const mapped = legacy[v]
    if (mapped) return orderedUnderlay(mapped, order)
  }
  return orderedUnderlay(fallback, order)
}

const LEGACY_SATIN_UNDERLAY: Record<string, SatinUnderlay[]> = {
  center: ['center'], edge: ['edge'], zigzag: ['zigzag'],
}
/** "double" was edge + zigzag all along. */
const LEGACY_FILL_UNDERLAY: Record<string, FillUnderlay[]> = {
  edge: ['edge'], zigzag: ['zigzag'], double: ['edge', 'zigzag'],
}

function objectIn(v: unknown, index: number): EmbObject | null {
  if (!isObj(v)) return null
  const paths = pathsIn(v.paths)
  const run = isObj(v.run) ? v.run : {}
  const satin = isObj(v.satin) ? v.satin : {}
  const fill = isObj(v.fill) ? v.fill : {}
  const border = isObj(fill.border) ? fill.border : {}
  const ap = isObj(v.applique) ? v.applique : {}
  const dRun = DEFAULT_RUN(), dSatin = DEFAULT_SATIN(), dFill = DEFAULT_FILL()
  const pf = isObj(v.puff) ? v.puff : {}
  const dApp = DEFAULT_APPLIQUE()
  const kd = isObj(v.knockdown) ? v.knockdown : {}
  const dPuff = DEFAULT_PUFF()
  const dKd = DEFAULT_KNOCKDOWN()
  return {
    id: str(v.id, `o${index + 1}`),
    name: str(v.name, `Object ${index + 1}`),
    color: /^#[0-9a-fA-F]{6}$/.test(String(v.color)) ? String(v.color) : '#1f6feb',
    thread: isObj(v.thread)
      ? {
          brand: typeof v.thread.brand === 'string' ? v.thread.brand : undefined,
          code: typeof v.thread.code === 'string' ? v.thread.code : undefined,
          name: typeof v.thread.name === 'string' ? v.thread.name : undefined,
        }
      : {},
    visible: v.visible !== false,
    type: oneOf(v.type, STITCH_TYPES, 'fill'),
    paths,
    shapes: shapesIn(v.shapes),
    entry: ptIn(v.entry),
    exit: ptIn(v.exit),
    guides: guidesIn(v.guides),
    applique: {
      tackWidth: num(ap.tackWidth, dApp.tackWidth),
      tackDensity: num(ap.tackDensity, dApp.tackDensity),
      borderWidth: num(ap.borderWidth, dApp.borderWidth),
      borderDensity: num(ap.borderDensity, dApp.borderDensity),
      borderPullComp: num(ap.borderPullComp, dApp.borderPullComp),
      border: ap.border !== false,
      borderStyle: ap.borderStyle === 'overlock' ? 'overlock' : 'satin',
    },
    knockdown: {
      spacing: num(kd.spacing, dKd.spacing),
      margin: num(kd.margin, dKd.margin),
      angle: num(kd.angle, dKd.angle),
      length: num(kd.length, dKd.length),
    },
    puff: {
      enabled: pf.enabled === true,
      thickness: num(pf.thickness, dPuff.thickness),
      densityScale: num(pf.densityScale, dPuff.densityScale),
      capEnds: pf.capEnds !== false,
    },
    ...(v.twoRail === true ? { twoRail: true } : {}),
    ...(isObj(v.text) && typeof v.text.content === 'string' ? {
      text: {
        content: v.text.content,
        family: typeof v.text.family === 'string' ? v.text.family : 'Georgia',
        sizeMm: num(v.text.sizeMm, 12),
        bold: v.text.bold === true,
        italic: v.text.italic === true,
        trackingMm: num(v.text.trackingMm, 0),
        // Added after the first lettering shipped; absent in older files,
        // where the honest reading is "no slant, no bend".
        wordSpacingMm: num(v.text.wordSpacingMm, 0),
        slantDeg: num(v.text.slantDeg, 0),
        curveTopMm: num(v.text.curveTopMm, 0),
        curveBottomMm: num(v.text.curveBottomMm, 0),
        mode: v.text.mode === 'satin' ? 'satin' : 'fill',
        nudges: isObj(v.text.nudges)
          ? Object.fromEntries(Object.entries(v.text.nudges).flatMap(([k, n]) =>
            isObj(n) ? [[Number(k), { dx: num(n.dx, 0), dy: num(n.dy, 0), rot: num(n.rot, 0) }]] : []))
          : undefined,
      },
    } : {}),
    run: { length: num(run.length, dRun.length) },
    satin: {
      width: num(satin.width, dSatin.width),
      density: num(satin.density, dSatin.density),
      pullComp: num(satin.pullComp, dSatin.pullComp),
      underlay: underlayIn(satin.underlay, SATIN_UNDERLAY_ORDER, LEGACY_SATIN_UNDERLAY, dSatin.underlay),
      lean: num(satin.lean, dSatin.lean),
    },
    fill: {
      angle: num(fill.angle, dFill.angle),
      spacing: num(fill.spacing, dFill.spacing),
      length: num(fill.length, dFill.length),
      stagger: num(fill.stagger, dFill.stagger),
      pullComp: num(fill.pullComp, dFill.pullComp),
      underlay: underlayIn(fill.underlay, FILL_UNDERLAY_ORDER, LEGACY_FILL_UNDERLAY, dFill.underlay),
      border: {
        enabled: border.enabled === true,
        width: num(border.width, dFill.border.width),
        density: num(border.density, dFill.border.density),
      },
    },
  }
}

/**
 * Migrations from older schema versions, applied in order.
 * Each takes the raw `doc` payload of version N and returns version N+1.
 */
const MIGRATIONS: Record<number, (doc: unknown) => unknown> = {
  // v1 is the first format; nothing precedes it. When v2 arrives, add:
  //   1: (doc) => ({ ...doc, newField: default }),
}

export function deserialize(text: string): Doc {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ProjectError('That file is not valid JSON — it may be a .dst export rather than a project.')
  }
  if (!isObj(parsed)) throw new ProjectError('That file is not a gleEmbroidery project.')
  if (parsed.format !== FILE_FORMAT)
    throw new ProjectError(
      `That file is not a gleEmbroidery project (format "${String(parsed.format ?? 'missing')}").`,
    )

  const version = parsed.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    throw new ProjectError('This project has no usable schema version and cannot be opened safely.')

  // The refusal that matters: do NOT half-read a file from a newer build and
  // then write the missing parts away on the next save.
  if (version > SCHEMA_VERSION)
    throw new ProjectError(
      `This project was saved by a newer version of gleEmbroidery (schema v${version}); ` +
        `this build understands up to v${SCHEMA_VERSION}. Update before opening it, ` +
        `so nothing in the file is silently discarded.`,
    )

  let payload = parsed.doc
  for (let v = version; v < SCHEMA_VERSION; v++) {
    const migrate = MIGRATIONS[v]
    if (!migrate) throw new ProjectError(`No migration from schema v${v} to v${v + 1}.`)
    payload = migrate(payload)
  }

  if (!isObj(payload)) throw new ProjectError('This project file has no document in it.')
  const objects = Array.isArray(payload.objects)
    ? payload.objects.map(objectIn).filter((o): o is EmbObject => o !== null)
    : []

  const doc: Doc = {
    name: str(payload.name, 'untitled'),
    hoop: hoopIn(payload.hoop),
    spacing: oneOf(payload.spacing, SPACINGS, 'TJ500'),
    ...(frozenIn(payload.frozen) ? { frozen: frozenIn(payload.frozen)! } : {}),
    objects,
  }
  // Saved ids must not collide with ids minted later in this session.
  registerExistingIds(objects.map((o) => o.id))
  return doc
}

/** Suggested filename for a document, without inventing an extension twice. */
export function projectFilename(doc: Doc): string {
  const base = (doc.name || 'untitled').replace(/[^\w\-. ]+/g, '_').trim() || 'untitled'
  return base.toLowerCase().endsWith(`.${FILE_EXT}`) ? base : `${base}.${FILE_EXT}`
}

/**
 * A content signature for a document.
 *
 * `useStitchPlan` must re-generate when the document CHANGES, not when its
 * object identity changes. Keying a React effect on the doc object itself
 * works only while the whole document lives in a single useState — which is
 * true here and emphatically not true in StoneCut, where a doc assembled by a
 * spread on every render would re-trigger the effect forever, clear its own
 * debounce each pass, and never produce a plan at all.
 *
 * TAKEN FROM THE SAVE FORMAT, not from a hand-written list of fields.
 *
 * The hand-written version was wrong, and wrong in the worst available way:
 * it covered the fields that existed when it was written, so every setting
 * added afterwards — the bar lean, angle guides, appliqué, puff, knockdown,
 * entry and exit — changed the document without changing its signature. The
 * control worked, the plan did not regenerate, and the canvas showed the old
 * stitches. That reads exactly like a setting that does nothing.
 *
 * `objectOut` is by definition the complete description of an object: it is
 * what a saved file contains, and the round-trip test asserts that nothing is
 * missing from it. Hashing that makes the signature self-maintaining — a new
 * field is covered the moment it can be saved, with nothing to remember.
 *
 * `savedAt` is deliberately NOT included (it would differ on every call).
 */
export function docSignature(doc: Doc): string {
  let h = 0x811c9dc5
  const mixStr = (v: string) => {
    for (let i = 0; i < v.length; i++) {
      h ^= v.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
  }
  mixStr(doc.name)
  mixStr(doc.spacing)
  const mix = (n: number) => {
    h ^= n | 0
    h = Math.imul(h, 0x01000193)
  }
  mixStr(JSON.stringify(hoopOut(doc.hoop)))
  for (const o of doc.objects) {
    // Settings: hashed wholesale from the save format, so a new one cannot be
    // left out. Cheap — there are a few dozen numbers per object.
    const saved: Record<string, unknown> = objectOut(o)
    const settings: Record<string, unknown> = {}
    for (const k of Object.keys(saved)) {
      if (!(SIGNATURE_GEOMETRY_KEYS as readonly string[]).includes(k)) settings[k] = saved[k]
    }
    mixStr(JSON.stringify(settings))
    // Geometry: folded numerically. Every coordinate goes in, so an edit that
    // preserves point counts still changes the signature.
    for (const path of o.paths) {
      mix(path.length)
      for (const q of path) { mix(Math.round(q.x * 1000)); mix(Math.round(q.y * 1000)) }
    }
    for (const sh of o.shapes ?? []) {
      mix(sh.nodes.length); mix(sh.closed ? 1 : 0)
      for (const n of sh.nodes) {
        mix(Math.round(n.x * 1000)); mix(Math.round(n.y * 1000))
        mix(Math.round((n.hIn?.x ?? 0) * 1000)); mix(Math.round((n.hIn?.y ?? 0) * 1000))
        mix(Math.round((n.hOut?.x ?? 0) * 1000)); mix(Math.round((n.hOut?.y ?? 0) * 1000))
        mix(n.smooth ? 1 : 0)
      }
    }
    for (const g of o.guides ?? []) {
      mix(Math.round(g.a.x * 1000)); mix(Math.round(g.a.y * 1000))
      mix(Math.round(g.b.x * 1000)); mix(Math.round(g.b.y * 1000))
    }
  }
  return (h >>> 0).toString(36) + ':' + doc.objects.length
}
