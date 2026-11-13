// Lettering: turn typed text into stitchable outlines.
//
// Names, team names, monograms — lettering is most of what a shop actually
// sews, and it is the one thing you cannot import from a customer's PNG
// because every job needs different words.
//
// HOW THE OUTLINES ARE OBTAINED, and why this way: the browser will render
// any installed font to a canvas but will not hand over glyph outlines.
// Getting true outlines means parsing TTF/OTF ourselves, which is a font
// library's worth of work and a megabyte of dependency. Instead the text is
// drawn to an offscreen canvas at high resolution and run through the tracer
// built for the magic wand — which already produces closed contours and, more
// importantly, already yields counters (the holes in O, A, B) as their own
// loops that toRegions() nests correctly.
//
// What that costs: outlines are polygons, not curves. At the 0.1 mm
// resolution used here that is well under the thickness of a single stitch,
// so nothing downstream can tell. What it buys: EVERY font on the machine
// works, including the shop's own licensed faces, with no parser to keep
// correct and no dependency to carry.
//
// This module needs the DOM (it rasterises text), so unlike trace.ts it is
// not covered headlessly. The part that does the real work — contour
// extraction — is tested there.

import { alphaMask, contoursToPaths, maskContours, type Raster } from './trace'
import { distanceTransform, pruneSpurs, railsAlong, smoothLine, thin, traceSkeleton } from './skeleton'
import type { Pt } from './model'

export interface TextSpec {
  content: string
  /** CSS font family, e.g. 'Georgia' or a face installed on the machine. */
  family: string
  /** CAP HEIGHT in mm — what a shop means by "half-inch letters". */
  sizeMm: number
  bold: boolean
  italic: boolean
  /** Extra space between letters, mm. Negative tightens. */
  trackingMm: number
  /** Extra space between words, mm, on top of the tracking. */
  wordSpacingMm: number
  /**
   * Shear, degrees. Positive leans right.
   *
   * Separate from the font's own italic: italic is a different set of
   * drawings by the type designer, slant is a geometric lean applied to
   * whatever face is chosen. A shop wants the second for a face that has no
   * italic, which is most display faces.
   */
  slantDeg: number
  /** How far the TOP of the lettering bows upward at its middle, mm. */
  curveTopMm: number
  /** How far the BOTTOM bows upward at its middle, mm. */
  curveBottomMm: number
  /** Per-letter nudges, sparse: index -> offset. */
  nudges?: Record<number, LetterNudge>
  /**
   * How the lettering is stitched.
   *
   * 'fill' tatamis the glyph outline; 'satin' runs a column down each stroke,
   * which is what lettering under about 20 mm actually wants — a fill at that
   * size is mostly underlay and looks flat.
   */
  mode: 'fill' | 'satin'
}

export const DEFAULT_TEXT: () => TextSpec = () => ({
  content: 'Text',
  family: 'Georgia',
  sizeMm: 12,
  bold: false,
  italic: false,
  trackingMm: 0,
  wordSpacingMm: 0,
  slantDeg: 0,
  curveTopMm: 0,
  curveBottomMm: 0,
  mode: 'fill',
})

/**
 * Faces offered in the picker.
 *
 * A starting list, not a limit — the family is a free-text field, so any face
 * installed on the machine can be typed in. Enumerating installed fonts needs
 * a permission prompt, which is a poor trade for a list most people will not
 * read.
 */
export const SUGGESTED_FACES = [
  'Georgia', 'Times New Roman', 'Palatino', 'Garamond',
  'Helvetica', 'Arial', 'Arial Black', 'Verdana', 'Tahoma', 'Impact',
  'Futura', 'Optima', 'Gill Sans', 'Baskerville', 'Didot',
  'Brush Script MT', 'Snell Roundhand', 'Zapfino', 'Copperplate', 'Courier New',
]

/** A satin column derived from one stroke of a letter. */
export interface LetterColumn {
  ch: string
  left: Pt[]
  right: Pt[]
}

/**
 * Turn typed text into SATIN COLUMNS, one per stroke.
 *
 * Filling a letter's outline is not satin lettering: satin runs ACROSS each
 * stroke, and the column has to know where the middle of the stroke is and
 * how thick it is there. Both come from the medial axis of the glyph — see
 * skeleton.ts for why that is computed on the raster rather than exactly.
 *
 * Returns one column per stroke, so a K comes back as its stem and two arms
 * rather than as one path wandering through the junction.
 */
export function textToColumns(spec: TextSpec): { columns: LetterColumn[]; warnings: string[] } {
  const warnings: string[] = []
  const r = rasteriseText(spec)
  if (!r) return { columns: [], warnings: ['could not render that text'] }
  const { ctx, w, h, left, content } = r

  const img = ctx.getImageData(0, 0, w, h)
  const mask = alphaMask({ data: img.data, width: w, height: h })
  const dist = distanceTransform(mask, w, h)
  const skel = thin(mask, w, h)
  // A spur shorter than the stroke is a bump on the outline, not a stroke.
  const minBranch = Math.max(4, spec.sizeMm * RASTER_PX_PER_MM * 0.18)
  const lines = pruneSpurs(traceSkeleton(skel, w, h), minBranch)
  if (!lines.length) return { columns: [], warnings: ['no strokes found — try a heavier face'] }

  // Which letter each stroke belongs to, by its midpoint's x band.
  const bands: { ch: string; from: number; to: number }[] = []
  let prev = 0
  for (let i = 0; i < content.length; i++) {
    const upTo = ctx.measureText(content.slice(0, i + 1)).width
    bands.push({ ch: content[i], from: prev, to: upTo })
    prev = upTo
  }
  const chAt = (px: number): string => {
    const x = px - left
    let best = bands[0]?.ch ?? '?', bestD = Infinity
    for (const b of bands) {
      const d = x < b.from ? b.from - x : x > b.to ? x - b.to : 0
      if (d < bestD) { bestD = d; best = b.ch }
    }
    return best
  }

  const columns: LetterColumn[] = []
  for (const line of lines) {
    const smooth = smoothLine(line, 4)
    const rails = railsAlong(smooth, dist, w, h, 1 / RASTER_PX_PER_MM)
    if (rails.left.length < 3) continue
    const midPx = smooth[Math.floor(smooth.length / 2)]
    columns.push({ ch: chAt(midPx.x), left: rails.left, right: rails.right })
  }
  if (!columns.length) warnings.push('no usable strokes — try a larger size')
  return { columns, warnings }
}

/**
 * Slant and bend already-flat outlines.
 *
 * Done AFTER rasterising rather than by transforming the canvas, because the
 * bend is not an affine transform — the top and bottom of the lettering move
 * by different amounts, which is what makes a fan or a taper rather than a
 * plain arc. A canvas transform cannot express that; moving the points can.
 *
 * Top and bottom bow INDEPENDENTLY: equal amounts arc the whole line, while
 * opposite amounts fan it wider at the middle. Each point is displaced by a
 * parabola across the width — zero at both ends, full at the centre — so the
 * lettering still starts and finishes on the baseline it was set on.
 *
 * Pure, so the suite covers it even though the rasteriser around it cannot be.
 */
export function shapeOutlines(paths: Pt[][], spec: TextSpec): Pt[][] {
  const slant = Math.tan((Math.max(-60, Math.min(60, spec.slantDeg)) * Math.PI) / 180)
  const bowTop = spec.curveTopMm
  const bowBottom = spec.curveBottomMm
  if (!slant && !bowTop && !bowBottom) return paths

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const ring of paths) for (const q of ring) {
    if (q.x < minX) minX = q.x
    if (q.x > maxX) maxX = q.x
    if (q.y < minY) minY = q.y
    if (q.y > maxY) maxY = q.y
  }
  const w = maxX - minX, h = maxY - minY
  if (!(w > 1e-9)) return paths
  // Shear about the BASELINE, not the middle: a slanted letter should keep
  // its feet where they were and lean its head over, which is what the eye
  // reads as italic.
  const baseY = maxY

  return paths.map((ring) => ring.map((q) => {
    const x = q.x + (baseY - q.y) * slant
    const u = (x - minX) / w
    // Parabola: 0 at both ends, 1 in the middle.
    const bell = 4 * u * (1 - u)
    // v = 0 at the top of the lettering, 1 at the bottom.
    const v = h > 1e-9 ? (q.y - minY) / h : 0
    const bow = bowTop + (bowBottom - bowTop) * v
    return { x, y: q.y - bow * bell }
  }))
}

/**
 * Pixels per millimetre used while rasterising.
 *
 * The outline can only be as accurate as the bitmap it was traced from, and
 * the error is about half a pixel. At 10 px/mm that is 0.05 mm — a seventh of
 * a stitch width, and invisible. Going finer costs memory quadratically for
 * accuracy nothing downstream can use.
 */
const RASTER_PX_PER_MM = 10

/** Margin around the rendered text, px — room for descenders and overhang. */
const PAD = 8

/**
 * Letter and word spacing.
 *
 * Both are recent canvas properties and absent in older engines; where they
 * are missing the text is simply not tracked, which is better than refusing
 * to set the type at all.
 */
function applySpacing(ctx: CanvasRenderingContext2D, spec: TextSpec, scale: number): void {
  const c = ctx as unknown as { letterSpacing: string; wordSpacing: string }
  if (spec.trackingMm) {
    try { c.letterSpacing = `${spec.trackingMm * RASTER_PX_PER_MM * scale}px` } catch { /* unsupported */ }
  }
  if (spec.wordSpacingMm) {
    try { c.wordSpacing = `${spec.wordSpacingMm * RASTER_PX_PER_MM * scale}px` } catch { /* unsupported */ }
  }
}

function fontString(spec: TextSpec, px: number): string {
  const style = spec.italic ? 'italic ' : ''
  const weight = spec.bold ? '700 ' : '400 '
  // Quote the family: faces with spaces in their names are the common case.
  return `${style}${weight}${px}px "${spec.family}", serif`
}

/** One glyph's outlines, kept separate so letters can be handled singly. */
export interface LetterOutline {
  ch: string
  /** Outer ring first, then any counters; all in document mm. */
  paths: Pt[][]
  /** Centre of this letter, for its handle. */
  centre: Pt
}

export interface TextOutlines {
  paths: Pt[][]
  /** The same outlines, grouped per letter. */
  letters: LetterOutline[]
  /** Width and cap height actually achieved, mm — for reporting. */
  widthMm: number
  heightMm: number
  warnings: string[]
}

/**
 * Per-letter nudges, indexed by position in the string.
 *
 * Kept on the spec rather than baked into the outlines so the lettering stays
 * live: moving a letter must survive changing the word, the face or the size,
 * and it does because the nudge is applied AFTER the glyphs are regenerated.
 */
export interface LetterNudge {
  dx: number
  dy: number
  /** Degrees, about the letter's own centre. */
  rot: number
}

/**
 * Rasterise and trace a line of text, centred on the origin.
 *
 * `sizeMm` is honoured as CAP HEIGHT rather than as the font's em size,
 * because "half-inch letters" is a measurement of the letters, not of the
 * invisible box around them — and the relationship between the two differs
 * per face, so an em size would make the same number mean a different size
 * in every font. The glyphs are measured once, then scaled to match.
 */
interface Rasterised {
  ctx: CanvasRenderingContext2D
  w: number
  h: number
  left: number
  up: number
  content: string
}

/**
 * Draw the text to an offscreen canvas at RASTER_PX_PER_MM.
 *
 * Shared by the outline and the satin paths so both see EXACTLY the same
 * pixels — a column traced from one bitmap and an outline traced from another
 * would not sit inside each other.
 */
function rasteriseText(spec: TextSpec): Rasterised | null {
  const content = spec.content
  if (!content.trim()) return null

  // Render at a reference size, measure what came out, then scale the result.
  // Measuring first and scaling after is what keeps sizeMm meaning the same
  // thing in a face with tall caps and one with short ones.
  const REF = 200
  const probe = document.createElement('canvas').getContext('2d')
  if (!probe) return null
  probe.font = fontString(spec, REF)
  applySpacing(probe, spec, REF / (spec.sizeMm * RASTER_PX_PER_MM || 1))
  const capPx = probe.measureText(content).actualBoundingBoxAscent || REF * 0.7
  if (!(capPx > 0)) return null

  const px = REF * ((spec.sizeMm * RASTER_PX_PER_MM) / capPx)
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.font = fontString(spec, px)
  applySpacing(ctx, spec, 1)
  const m2 = ctx.measureText(content)
  const left = Math.ceil(m2.actualBoundingBoxLeft) + PAD
  const right = Math.ceil(m2.actualBoundingBoxRight) + PAD
  const up = Math.ceil(m2.actualBoundingBoxAscent) + PAD
  const down = Math.ceil(m2.actualBoundingBoxDescent) + PAD
  const w = Math.max(1, left + right)
  const h = Math.max(1, up + down)
  if (w * h > 40_000_000) return null

  ctx.canvas.width = w
  ctx.canvas.height = h
  // Resizing a canvas RESETS its context, so the font must be set again.
  ctx.font = fontString(spec, px)
  applySpacing(ctx, spec, 1)
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#fff'
  ctx.fillText(content, left, up)
  return { ctx, w, h, left, up, content }
}

export function textToOutlines(spec: TextSpec): TextOutlines {
  const warnings: string[] = []
  const content = spec.content
  const r = rasteriseText(spec)
  if (!r) return { paths: [], letters: [], widthMm: 0, heightMm: 0, warnings: ['could not render that text'] }
  const { ctx: ctx2, w, h, left } = r

  const img = ctx2.getImageData(0, 0, w, h)
  const raster: Raster = { data: img.data, width: w, height: h }
  const { paths, dropped } = contoursToPaths(maskContours(alphaMask(raster), w, h), {
    pxPerMm: RASTER_PX_PER_MM,
    originMm: { x: 0, y: 0 },
    // Finer than the wand's default: a letter's curves are the whole point,
    // and 0.08 mm is a fifth of a stitch width.
    simplifyMm: 0.08,
    // Anti-aliasing leaves single-pixel crumbs around sharp serifs; they are
    // not features of the letter and cannot be sewn.
    minAreaPx: 6,
  })
  if (dropped) warnings.push(`${dropped} speck${dropped === 1 ? ' was' : 's were'} too small to sew — dropped`)
  if (!paths.length) {
    return { paths: [], letters: [], widthMm: 0, heightMm: 0, warnings: ['that font produced no glyphs — check the name'] }
  }

  // Group the contours into letters.
  //
  // By the x BAND each glyph occupies, measured from prefix widths — which
  // keeps the engine's kerning, unlike rendering each letter on its own
  // canvas. A counter's centroid lies inside its parent's band, so holes stay
  // with the letter they belong to without any nesting logic here.
  const bands: { ch: string; from: number; to: number }[] = []
  {
    let prev = 0
    for (let i = 0; i < content.length; i++) {
      const upTo = ctx2.measureText(content.slice(0, i + 1)).width
      bands.push({ ch: content[i], from: prev, to: upTo })
      prev = upTo
    }
  }
  const bandOf = (ring: Pt[]): number => {
    let sx = 0
    for (const q of ring) sx += q.x
    // Contours are still in mm from the canvas origin at this point; the text
    // was drawn starting at `left` px.
    const cxPx = (sx / ring.length) * RASTER_PX_PER_MM - left
    let best = 0, bestD = Infinity
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i]
      const d = cxPx < b.from ? b.from - cxPx : cxPx > b.to ? cxPx - b.to : 0
      if (d < bestD) { bestD = d; best = i }
    }
    return best
  }
  const grouped: Pt[][][] = bands.map(() => [])
  for (const ring of paths) grouped[bandOf(ring)].push(ring)

  // Apply each letter's nudge about its own centre, BEFORE the line-wide
  // slant and bend, so a moved letter still follows the curve of the line.
  const nudged: Pt[][] = []
  const letterRings: Pt[][][] = []
  grouped.forEach((rings, i) => {
    const n = spec.nudges?.[i]
    if (!rings.length) { letterRings.push([]); return }
    if (!n || (!n.dx && !n.dy && !n.rot)) {
      letterRings.push(rings)
      nudged.push(...rings)
      return
    }
    let sx = 0, sy = 0, c = 0
    for (const r of rings) for (const q of r) { sx += q.x; sy += q.y; c++ }
    const cx = sx / c, cy = sy / c
    const a = (n.rot * Math.PI) / 180
    const cos = Math.cos(a), sin = Math.sin(a)
    const moved = rings.map((r) => r.map((q) => {
      const ox = q.x - cx, oy = q.y - cy
      return { x: cx + ox * cos - oy * sin + n.dx, y: cy + ox * sin + oy * cos + n.dy }
    }))
    letterRings.push(moved)
    nudged.push(...moved)
  })

  // Slant and bend before centring, so the centring accounts for the shape
  // that actually results.
  const shaped = shapeOutlines(nudged, spec)

  // Centre on the origin so the text lands where it was clicked, and so
  // resizing it later turns about its own middle.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const ring of shaped) for (const q of ring) {
    if (q.x < minX) minX = q.x
    if (q.y < minY) minY = q.y
    if (q.x > maxX) maxX = q.x
    if (q.y > maxY) maxY = q.y
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  const close = (ring: Pt[]) => {
    const shifted = ring.map((q) => ({ x: q.x - cx, y: q.y - cy }))
    // Close each ring; the fill engine reads these as regions.
    return [...shifted, { ...shifted[0] }]
  }
  const centred = shaped.map(close)

  // Re-split the shaped outlines back into letters. Shaping preserves order,
  // so the counts walk in step.
  const letters: LetterOutline[] = []
  let k = 0
  letterRings.forEach((rings, i) => {
    if (!rings.length) return
    const mine = centred.slice(k, k + rings.length)
    k += rings.length
    let sx = 0, sy = 0, n = 0
    for (const r of mine) for (const q of r) { sx += q.x; sy += q.y; n++ }
    letters.push({ ch: bands[i].ch, paths: mine, centre: { x: sx / n, y: sy / n } })
  })

  return {
    paths: centred,
    letters,
    widthMm: maxX - minX,
    heightMm: maxY - minY,
    warnings,
  }
}
