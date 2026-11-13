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
}

export const DEFAULT_TEXT: () => TextSpec = () => ({
  content: 'Text',
  family: 'Georgia',
  sizeMm: 12,
  bold: false,
  italic: false,
  trackingMm: 0,
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

function fontString(spec: TextSpec, px: number): string {
  const style = spec.italic ? 'italic ' : ''
  const weight = spec.bold ? '700 ' : '400 '
  // Quote the family: faces with spaces in their names are the common case.
  return `${style}${weight}${px}px "${spec.family}", serif`
}

export interface TextOutlines {
  paths: Pt[][]
  /** Width and cap height actually achieved, mm — for reporting. */
  widthMm: number
  heightMm: number
  warnings: string[]
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
export function textToOutlines(spec: TextSpec): TextOutlines {
  const warnings: string[] = []
  const content = spec.content
  if (!content.trim()) return { paths: [], widthMm: 0, heightMm: 0, warnings: ['no text'] }

  // Render at a reference size, measure what came out, then scale the result.
  // Measuring first and scaling after is what keeps sizeMm meaning the same
  // thing in a face with tall caps and one with short ones.
  const REF = 200
  const probe = document.createElement('canvas').getContext('2d')
  if (!probe) return { paths: [], widthMm: 0, heightMm: 0, warnings: ['could not measure text'] }
  probe.font = fontString(spec, REF)
  if (spec.trackingMm) {
    // letterSpacing is not in every engine; where it is missing the text is
    // simply not tracked, which is better than refusing to set the type.
    try { (probe as unknown as { letterSpacing: string }).letterSpacing = `${spec.trackingMm * RASTER_PX_PER_MM}px` } catch { /* unsupported */ }
  }
  const m = probe.measureText(content)
  const capPx = m.actualBoundingBoxAscent || REF * 0.7
  if (!(capPx > 0)) return { paths: [], widthMm: 0, heightMm: 0, warnings: ['that font produced no glyphs'] }

  // Scale so the measured cap height becomes the requested size.
  const px = REF * ((spec.sizeMm * RASTER_PX_PER_MM) / capPx)
  const ctx2 = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!ctx2) return { paths: [], widthMm: 0, heightMm: 0, warnings: ['could not draw text'] }
  ctx2.font = fontString(spec, px)
  if (spec.trackingMm) {
    try { (ctx2 as unknown as { letterSpacing: string }).letterSpacing = `${spec.trackingMm * RASTER_PX_PER_MM}px` } catch { /* unsupported */ }
  }
  const m2 = ctx2.measureText(content)
  const left = Math.ceil(m2.actualBoundingBoxLeft) + PAD
  const right = Math.ceil(m2.actualBoundingBoxRight) + PAD
  const up = Math.ceil(m2.actualBoundingBoxAscent) + PAD
  const down = Math.ceil(m2.actualBoundingBoxDescent) + PAD
  const w = Math.max(1, left + right)
  const h = Math.max(1, up + down)
  if (w * h > 40_000_000) {
    return { paths: [], widthMm: 0, heightMm: 0, warnings: ['that is too much text to outline at once — split it'] }
  }

  const cv = ctx2.canvas
  cv.width = w
  cv.height = h
  // Resizing a canvas resets its context, so the font must be set again.
  ctx2.font = fontString(spec, px)
  if (spec.trackingMm) {
    try { (ctx2 as unknown as { letterSpacing: string }).letterSpacing = `${spec.trackingMm * RASTER_PX_PER_MM}px` } catch { /* unsupported */ }
  }
  ctx2.textBaseline = 'alphabetic'
  ctx2.fillStyle = '#fff'
  ctx2.fillText(content, left, up)

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
    return { paths: [], widthMm: 0, heightMm: 0, warnings: ['that font produced no glyphs — check the name'] }
  }

  // Centre on the origin so the text lands where it was clicked, and so
  // resizing it later turns about its own middle.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const ring of paths) for (const q of ring) {
    if (q.x < minX) minX = q.x
    if (q.y < minY) minY = q.y
    if (q.x > maxX) maxX = q.x
    if (q.y > maxY) maxY = q.y
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  const centred = paths.map((ring) => {
    const shifted = ring.map((q) => ({ x: q.x - cx, y: q.y - cy }))
    // Close each ring; the fill engine reads these as regions.
    return [...shifted, { ...shifted[0] }]
  })
  return {
    paths: centred,
    widthMm: maxX - minX,
    heightMm: maxY - minY,
    warnings,
  }
}
