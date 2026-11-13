// Native embroidery alphabets.
//
// A system font is a set of drawings for PRINT. Rasterising one and tracing
// it, which is how lettering works everywhere else in this program, gets you
// a shape that is correct for ink on paper and merely plausible for thread
// in cloth: the thin parts of a Georgia lower-case e are under a millimetre,
// and under a millimetre there is nothing a needle can do.
//
// An embroidery alphabet is the other thing. Each letter is a shape SOMEONE
// DIGITIZED — thickened where it had to be, with its counters opened up and
// its joins adjusted — and once that work is done for a face it should never
// have to be done again.
//
// WHAT THIS IS, PRECISELY. It stores outlines, not stitches. A letter is
// geometry, and it is stitched by whatever settings the object carries, so
// the same alphabet sews as a satin at 8 mm and as a fill at 40 mm. Storing
// stitches instead would freeze the density, the underlay and the pull
// compensation into the letterform, and an alphabet captured on one fabric
// would be wrong on every other.
//
// HONEST LIMIT, and it is the important one: an alphabet contains the
// characters someone put in it and no others. A missing character is
// REPORTED, never substituted from a system font — silently mixing a
// digitized A with a traced B gives a word whose letters do not match, and
// the mismatch is only obvious once it has been sewn.
//
// Pure and DOM-free.

import type { Pt } from './model'
import { bounds } from './model'

export interface Glyph {
  /**
   * Outlines in mm, normalised: baseline at y = 0, left edge at x = 0,
   * and the letter ABOVE the baseline (so y is negative, since +Y is down).
   */
  paths: Pt[][]
  /** How far the pen moves after this letter, mm — its width plus sidebearing. */
  advanceMm: number
}

export interface Alphabet {
  id: string
  name: string
  /** The cap height the glyphs are stored at, mm. Everything scales from it. */
  capHeightMm: number
  glyphs: Record<string, Glyph>
  note?: string
}

/**
 * Side bearing added either side of a captured letter, as a fraction of its
 * cap height.
 *
 * Letters captured from artwork have no spacing information — they are just
 * shapes — so something has to decide how close they sit. A twelfth of the
 * cap height is about what a text face uses, and it is adjustable per line
 * through the existing letter-spacing control.
 */
export const SIDE_BEARING = 1 / 12

/**
 * Normalise a captured outline into a glyph.
 *
 * The letter is moved so its baseline is at y = 0 and its left edge at
 * x = 0, and SCALED so its height is the alphabet's cap height. Without the
 * scaling, a letter captured at 30 mm and another at 12 mm would set a word
 * with two sizes of type in it.
 *
 * Height is measured from the glyph's own extent, which means a letter with
 * a descender (a lower-case g) is normalised by its whole height rather than
 * by its cap. Capturing capitals is therefore the reliable way to build an
 * alphabet, and that is what the UI asks for.
 */
export function normaliseGlyph(paths: readonly Pt[][], capHeightMm: number): Glyph | null {
  const b = bounds(paths as Pt[][])
  if (!b) return null
  const h = b.maxY - b.minY
  const w = b.maxX - b.minX
  if (!(h > 1e-6) || !(w > 1e-9)) return null
  const k = capHeightMm / h
  return {
    paths: paths.map((ring) => ring.map((q) => ({
      x: (q.x - b.minX) * k,
      // Baseline at 0 with the letter above it: +Y is down, so the glyph
      // lives in negative y.
      y: (q.y - b.maxY) * k,
    }))),
    advanceMm: w * k + capHeightMm * SIDE_BEARING * 2,
  }
}

export interface SetTextResult {
  /** Outlines in mm, baseline on y = 0, starting at x = 0. */
  paths: Pt[][]
  /** The same, grouped per character that produced them. */
  letters: { ch: string; paths: Pt[][] }[]
  widthMm: number
  /** Characters the alphabet does not have, in the order they appeared. */
  missing: string[]
}

/**
 * Set a line of text from an alphabet.
 *
 * Spaces advance without drawing, and a character the alphabet does not have
 * advances by the same amount and is reported. Leaving a GAP rather than
 * closing up is deliberate: a word with a hole in it is obviously wrong,
 * while a word silently missing a letter reads as a typo and gets sewn.
 */
export function setAlphabetText(
  alphabet: Alphabet, text: string, sizeMm: number, trackingMm = 0,
): SetTextResult {
  const k = sizeMm / Math.max(1e-6, alphabet.capHeightMm)
  const space = alphabet.capHeightMm * k * 0.4
  const paths: Pt[][] = []
  const letters: { ch: string; paths: Pt[][] }[] = []
  const missing: string[] = []
  let pen = 0
  for (const ch of text) {
    if (ch === ' ') { pen += space + trackingMm; continue }
    const g = alphabet.glyphs[ch]
    if (!g) {
      missing.push(ch)
      pen += space + trackingMm
      continue
    }
    const placed = g.paths.map((ring) => ring.map((q) => ({ x: pen + q.x * k, y: q.y * k })))
    letters.push({ ch, paths: placed })
    paths.push(...placed)
    pen += g.advanceMm * k + trackingMm
  }
  return {
    paths,
    letters,
    widthMm: Math.max(0, pen - trackingMm),
    missing: [...new Set(missing)],
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export const ALPHABETS_KEY = 'gleembroidery.alphabets.v1'

export function serializeAlphabets(list: readonly Alphabet[]): string {
  return JSON.stringify(list.map((a) => ({
    id: a.id,
    name: a.name,
    capHeightMm: a.capHeightMm,
    ...(a.note ? { note: a.note } : {}),
    glyphs: Object.fromEntries(Object.entries(a.glyphs).map(([ch, g]) => [ch, {
      a: g.advanceMm,
      // Flat number pairs: a 60-letter alphabet is a lot of points, and
      // {x,y} objects roughly triple the stored size for nothing.
      p: g.paths.map((ring) => ring.flatMap((q) => [q.x, q.y])),
    }])),
  })))
}

/**
 * Read saved alphabets, dropping anything malformed.
 *
 * A glyph whose coordinates are not a clean pair list is DROPPED rather than
 * repaired: half a letterform is not a letter, and a word set from one would
 * sew a shape nobody drew.
 */
export function parseAlphabets(text: string | null): Alphabet[] {
  if (!text) return []
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return [] }
  if (!Array.isArray(raw)) return []
  const out: Alphabet[] = []
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue
    const a = v as Record<string, unknown>
    if (typeof a.id !== 'string' || typeof a.name !== 'string') continue
    const cap = typeof a.capHeightMm === 'number' && a.capHeightMm > 0 ? a.capHeightMm : 10
    const glyphs: Record<string, Glyph> = {}
    const src = a.glyphs && typeof a.glyphs === 'object' ? a.glyphs as Record<string, unknown> : {}
    for (const [ch, gv] of Object.entries(src)) {
      if (!gv || typeof gv !== 'object') continue
      const g = gv as Record<string, unknown>
      if (!Array.isArray(g.p)) continue
      const rings: Pt[][] = []
      for (const flat of g.p) {
        if (!Array.isArray(flat) || flat.length < 6 || flat.length % 2 !== 0) continue
        if (!flat.every((n) => typeof n === 'number' && isFinite(n))) continue
        const ring: Pt[] = []
        for (let i = 0; i < flat.length; i += 2) ring.push({ x: flat[i], y: flat[i + 1] })
        rings.push(ring)
      }
      if (!rings.length) continue
      const adv = typeof g.a === 'number' && isFinite(g.a) && g.a > 0
        ? g.a
        : (bounds(rings)?.maxX ?? cap)
      glyphs[ch] = { paths: rings, advanceMm: adv }
    }
    if (!Object.keys(glyphs).length) continue
    out.push({
      id: a.id,
      name: a.name,
      capHeightMm: cap,
      glyphs,
      ...(typeof a.note === 'string' ? { note: a.note } : {}),
    })
  }
  return out
}

/** Which characters an alphabet can set, sorted for display. */
export function alphabetCoverage(a: Alphabet): string[] {
  return Object.keys(a.glyphs).sort()
}
