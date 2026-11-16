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
import { distanceTransform, pruneSpurs, railsAlong, smoothLine, thin, traceSkeleton, trimAtJunctions } from './skeleton'
import { axisBranches, railsFromAxis, trimAxis } from './mat'
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
   * A baseline for the lettering to follow, in document mm.
   *
   * More general than curveTop/curveBottom, which bow the type between two
   * fixed ends; a path can go anywhere. They compose — the envelope is
   * applied first, then the whole thing is bent along the path.
   */
  path?: Pt[]
  /**
   * What happens when the path is not the same length as the lettering.
   *
   * 'keep-size' holds the letters at their stated cap height and lets the
   * line start at the path's beginning. This is the default and it is the
   * default on purpose: sizeMm is a PHYSICAL measurement a shop quoted and
   * a customer approved, and silently resizing the type to make it reach
   * the end of a curve would change the thing that was agreed.
   *
   * 'fit-path' scales the line along its length to span the path exactly.
   * Useful, and it says what it does.
   */
  pathFit?: 'keep-size' | 'fit-path'
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
/**
 * Superseded by fonts.ts, which carries the whole shop catalogue.
 *
 * Kept only because a stored TextSpec may name any of these and the engine
 * must not care where a family name came from.
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
  // A spur shorter than the stroke is a bump on the outline, not a stroke —
  // and the measure of that is the STROKE's width, not the font's size.
  //
  // This took its threshold from sizeMm, which is a different quantity and
  // not proportional to it: how thick a face draws its stems is the
  // difference between Verdana and Didot at the same size. At 12 mm that
  // worked out at 2.16 mm, while Verdana's strokes are about 1.6 mm wide, so
  // every stroke SHORTER than 2.16 mm was pruned as a spur — the arm of an
  // r, the crossbar of an e, the finial of an a. "Bowman Scholars" came back
  // with half its strokes missing and no word about it.
  //
  // The distance transform already knows the stroke width: it is twice the
  // median distance along the skeleton.
  let medHalf = 0
  {
    const ds: number[] = []
    for (let i = 0; i < skel.length; i++) if (skel[i]) ds.push(dist[i])
    ds.sort((a, b) => a - b)
    medHalf = ds.length ? ds[ds.length >> 1] : 0
  }
  const minBranch = medHalf > 0 ? Math.max(4, medHalf * 1.2) : Math.max(4, spec.sizeMm * RASTER_PX_PER_MM * 0.18)
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
  const dropped: string[] = []
  for (const line of lines) {
    // NO JUNCTION TRIM HERE. It was added on the reasoning that a branch
    // running into a junction picks up the combined width of both strokes —
    // true, and it wrecked real lettering. Its length floor asks a branch to
    // be a few multiples of its own half-width, and at 12 mm cap height a
    // letter's strokes are ~0.9 mm half-width and a few millimetres long, so
    // most of a word was discarded as junction leftovers. "Bowman Scholars"
    // came back as a smear.
    //
    // The same reasoning lives in mat.ts, where it is applied to an EXACT
    // axis with a floor of one stroke width rather than several, and where
    // it can be tested headlessly. This path rasterises text, so it needs a
    // browser and nothing here is covered by the suite — which is exactly
    // why an untested improvement had no business being applied to it.
    const smooth = smoothLine(line, 4)
    const rails = railsAlong(smooth, dist, w, h, 1 / RASTER_PX_PER_MM)
    const midPx = smooth[Math.floor(smooth.length / 2)]
    if (rails.left.length < 3) {
      // SAID, not skipped. A silently dropped stroke is a letter with a
      // piece missing, found on the garment rather than on the screen.
      dropped.push(chAt(midPx.x))
      continue
    }
    columns.push({ ch: chAt(midPx.x), left: rails.left, right: rails.right })
  }
  if (dropped.length) {
    const which = [...new Set(dropped)].join('')
    warnings.push(`${dropped.length} stroke(s) could not be made into columns (in “${which}”) — too thin at this size for satin`)
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
 * Bend a line of lettering along a baseline path.
 *
 * Every outline point is mapped by where it sits ALONG the lettering (which
 * becomes arc length on the path) and how far it sits ABOVE the baseline
 * (which becomes distance along the path's normal). The letters therefore
 * follow the path's curvature rather than being rotated as rigid stamps —
 * a stamped version stands off the line wherever the line turns, which on a
 * tight arc is most of it.
 *
 * THE PATH'S DIRECTION IS THE READING DIRECTION. A path drawn right to left
 * sets the type upside down, and that is correct rather than a bug: it is
 * how you put lettering along the bottom of a circular crest.
 *
 * Returns the mapped outlines and, when the path could not hold the
 * lettering at its stated size, a note saying so. It does NOT quietly
 * resize: sizeMm is a physical measurement someone quoted.
 */
export function textOnPath(
  paths: Pt[][], baseline: Pt[], fit: 'keep-size' | 'fit-path' = 'keep-size',
): { paths: Pt[][]; warnings: string[] } {
  const warnings: string[] = []
  const line = baseline.filter((p, i, a) =>
    i === 0 || Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) > 1e-9)
  if (line.length < 2 || !paths.length) return { paths, warnings }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const ring of paths) for (const q of ring) {
    if (q.x < minX) minX = q.x
    if (q.x > maxX) maxX = q.x
    if (q.y < minY) minY = q.y
    if (q.y > maxY) maxY = q.y
  }
  const w = maxX - minX
  if (!(w > 1e-9)) return { paths, warnings }
  // The baseline of the type sits at the BOTTOM of its box, which is the
  // same convention the slant uses — feet on the line, heads above it.
  const baseY = maxY

  // Walk the path once so a frame is available at any arc length.
  const cum = [0]
  for (let i = 1; i < line.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y))
  }
  const total = cum[cum.length - 1]
  if (total < 1e-9) return { paths, warnings }

  const scale = fit === 'fit-path' ? total / w : 1
  if (fit === 'keep-size' && w > total + 0.5) {
    warnings.push(
      `the lettering is ${w.toFixed(1)} mm long and the path is ${total.toFixed(1)} mm — `
      + 'the end runs on past it. Lengthen the path, shorten the words, or choose Fit to path.')
  }

  const frameAt = (s: number) => {
    // Past either end the path is EXTENDED along its own tangent rather than
    // clamped. Clamping would pile every overflowing letter on top of the
    // last point, which looks like a bug rather than like running out of
    // room; extending shows exactly how much too long the text is.
    if (s <= 0) {
      const t = unitBetween(line[0], line[1])
      return { at: { x: line[0].x + t.x * s, y: line[0].y + t.y * s }, t }
    }
    if (s >= total) {
      const a = line[line.length - 2], b = line[line.length - 1]
      const t = unitBetween(a, b)
      const over = s - total
      return { at: { x: b.x + t.x * over, y: b.y + t.y * over }, t }
    }
    let i = 1
    while (i < cum.length - 1 && cum[i] < s) i++
    const a = line[i - 1], b = line[i]
    const span = cum[i] - cum[i - 1]
    const f = span > 1e-12 ? (s - cum[i - 1]) / span : 0
    return {
      at: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f },
      t: unitBetween(a, b),
    }
  }

  const mapped = paths.map((ring) => ring.map((q) => {
    const s = (q.x - minX) * scale
    const above = (baseY - q.y) * scale
    const f = frameAt(s)
    // The normal points to the LEFT of travel, which with +Y down puts it
    // above the line — where the letters go.
    const n = { x: f.t.y, y: -f.t.x }
    return { x: f.at.x + n.x * above, y: f.at.y + n.y * above }
  }))
  return { paths: mapped, warnings }
}

function unitBetween(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x, dy = b.y - a.y
  const l = Math.hypot(dx, dy) || 1
  return { x: dx / l, y: dy / l }
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
  /**
   * The outlines are already in DOCUMENT coordinates and must not be moved.
   *
   * True only when the lettering was laid along a baseline path: the path
   * says where the type goes, so the usual centre-on-origin-and-let-the-
   * caller-place-it dance would bend the letters onto the curve and then
   * carry them off it.
   */
  absolute?: boolean
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

  // A baseline path places the lettering ABSOLUTELY — the type goes where
  // the curve is. Everything else about the pipeline centres on the origin
  // and lets the caller put it where it belongs, so a path has to turn that
  // off or the lettering would be bent onto the path and then moved away
  // from it.
  const onPath = spec.path && spec.path.length >= 2
    ? textOnPath(shaped, spec.path, spec.pathFit ?? 'keep-size')
    : null
  if (onPath) {
    warnings.push(...onPath.warnings)
    const closed = onPath.paths.map((ring) => [...ring, { ...ring[0] }])
    let pminX = Infinity, pminY = Infinity, pmaxX = -Infinity, pmaxY = -Infinity
    for (const ring of closed) for (const q of ring) {
      if (q.x < pminX) pminX = q.x
      if (q.y < pminY) pminY = q.y
      if (q.x > pmaxX) pmaxX = q.x
      if (q.y > pmaxY) pmaxY = q.y
    }
    const pLetters: LetterOutline[] = []
    let pk = 0
    letterRings.forEach((rings, i) => {
      if (!rings.length) return
      const mine = closed.slice(pk, pk + rings.length)
      pk += rings.length
      let sx = 0, sy = 0, n = 0
      for (const r of mine) for (const q of r) { sx += q.x; sy += q.y; n++ }
      pLetters.push({ ch: bands[i].ch, paths: mine, centre: { x: sx / n, y: sy / n } })
    })
    return {
      paths: closed,
      letters: pLetters,
      widthMm: pmaxX - pminX,
      heightMm: pmaxY - pminY,
      warnings,
      absolute: true,
    }
  }

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

/**
 * Turn a CLOSED filled outline into satin columns — the traced-letters path.
 *
 * `textToColumns` does this for text the app set itself, where the words are
 * known. Artwork traced with the wand has no words behind it: it is a set of
 * polygons that happen to look like letters, and it arrives as a FILL, which
 * on a 15 mm letter is the wrong stitch — a tatami letter reads as a flat
 * patch where a satin one has the sheen that makes lettering look sewn
 * rather than printed.
 *
 * The pipeline is the same one, and deliberately so: rasterise, distance
 * transform, thin to a skeleton, prune the spurs, then build a rail pair
 * either side of each stroke at twice the local distance. It is a RASTER
 * medial axis rather than an exact polygon one for the reason recorded in
 * skeleton.ts — the exact version degenerates on parallel stems, serifs and
 * tangent curves, which is precisely what letters are made of.
 *
 * THE SAME HONEST LIMIT APPLIES. This suits bold shapes at size. Thin
 * strokes fall under the satin floor and are refused with a reason rather
 * than sewn as something that will not hold.
 */
export async function outlineToColumns(
  paths: Pt[][],
): Promise<{ columns: { left: Pt[]; right: Pt[] }[]; warnings: string[] }> {
  const warnings: string[] = []
  const rings = paths.filter((p) => p.length >= 3)
  if (!rings.length) return { columns: [], warnings: ['no closed outline to work from'] }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const r of rings) for (const p of r) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  const pad = 4
  const w = Math.ceil((maxX - minX) * RASTER_PX_PER_MM) + pad * 2
  const h = Math.ceil((maxY - minY) * RASTER_PX_PER_MM) + pad * 2
  if (w < 8 || h < 8 || w > 4000 || h > 4000) {
    return { columns: [], warnings: ['that shape is too small or too large to trace into columns'] }
  }

  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return { columns: [], warnings: ['could not rasterise that shape'] }
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  for (const ring of rings) {
    ring.forEach((p, i) => {
      const x = (p.x - minX) * RASTER_PX_PER_MM + pad
      const y = (p.y - minY) * RASTER_PX_PER_MM + pad
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    })
    ctx.closePath()
  }
  // EVEN-ODD, so a counter stays a hole. Filling non-zero would weld the
  // middle of an O shut and the skeleton would run round a solid blob.
  ctx.fill('evenodd')

  const img = ctx.getImageData(0, 0, w, h)
  const mask = alphaMask({ data: img.data, width: w, height: h })
  const dist = distanceTransform(mask, w, h)
  const skel = thin(mask, w, h)
  // A spur shorter than the local stroke width is a bump on the outline, not
  // a stroke of its own — the same judgement textToColumns makes, scaled off
  // the shape rather than off a font size nobody stated.
  const shortSide = Math.min(maxX - minX, maxY - minY)
  const minBranch = Math.max(4, shortSide * RASTER_PX_PER_MM * 0.18)
  const lines = pruneSpurs(traceSkeleton(skel, w, h), minBranch)
  if (!lines.length) return { columns: [], warnings: ['no strokes found in that shape'] }

  const columns: { left: Pt[]; right: Pt[] }[] = []
  let junk = 0

  // EXACT MEDIAL AXIS FIRST. flo-mat computes it from the outline itself, so
  // the half-width is the inscribed circle's radius rather than a quantised
  // distance transform, and a junction is a branch point in a graph rather
  // than a bulge to be recognised. Measured on an 8 mm bar: 8.00 mm, against
  // a raster estimate at 10 px/mm.
  //
  // The raster route stays as the fallback. It is approximate but it never
  // refuses, and a traced logo is exactly where an exact method meets the
  // self-touching, hair-thin, not-quite-closed outline it cannot handle.
  const axis = await axisBranches(rings)
  if (axis) {
    for (const branch of axis) {
      const kept = trimAxis(branch)
      if (!kept) { junk++; continue }
      const rails = railsFromAxis(kept)
      if (rails.left.length < 3) continue
      columns.push(rails)
    }
    if (columns.length) {
      if (junk) {
        warnings.push(`${junk} piece(s) were junction leftovers and were dropped — check nothing is missing`)
      }
      return { columns, warnings }
    }
    // Nothing usable from the exact axis: fall through and let the raster
    // route try, rather than refuse a shape another method might manage.
    junk = 0
  }

  for (const line of lines) {
    // Pull the branch out of its junctions before building rails. Without
    // this a stroke running into one picks up the COMBINED width of both
    // strokes meeting there, and the leftover skeleton inside a junction
    // becomes a column of its own that collapses under the satin floor.
    const trimmed = trimAtJunctions(line, dist, w, h)
    if (!trimmed) { junk++; continue }
    const rails = railsAlong(smoothLine(trimmed, 4), dist, w, h, 1 / RASTER_PX_PER_MM)
    if (rails.left.length < 3) continue
    const back = (pts: Pt[]) => pts.map((p) => ({
      x: (p.x * RASTER_PX_PER_MM - pad) / RASTER_PX_PER_MM + minX,
      y: (p.y * RASTER_PX_PER_MM - pad) / RASTER_PX_PER_MM + minY,
    }))
    columns.push({ left: back(rails.left), right: back(rails.right) })
  }
  if (!columns.length) {
    warnings.push('no usable strokes — the shape may be too thin, or made entirely of junctions')
  } else if (junk) {
    // Said out loud: a letter whose crossbar was dropped is a letter with a
    // missing stroke, and that must not be discovered on the garment.
    warnings.push(`${junk} piece(s) were junction leftovers and were dropped — check nothing is missing`)
  }
  return { columns, warnings }
}

/**
 * Lettering as satin, from the EXACT medial axis.
 *
 * textToColumns does this by rasterising the word at 10 px/mm, thinning it
 * to a skeleton and reading a distance transform — every step of which is an
 * approximation, and none of which the suite can reach, because it needs a
 * browser. Three faults in one day came out of that: a junction trim whose
 * length floor discarded most of a word, a spur threshold measured against
 * the font SIZE rather than the stroke width, and a stroke that could not be
 * railed vanishing on a bare `continue`.
 *
 * The outlines still come from the rasteriser — browsers do not expose glyph
 * curves — but from there this is exact: flo-mat computes the medial axis of
 * the outline itself, so the half-width is the inscribed circle's radius and
 * a junction is a branch point rather than a bulge. And `axisBranches`,
 * `trimAxis` and `railsFromAxis` are all DOM-free, so the part that kept
 * going wrong is the part that is now tested.
 *
 * Per LETTER, not per word: the MAT of one glyph is a smaller problem, a
 * letter it cannot handle does not take the word down with it, and the
 * attribution comes free from outlines that are already grouped.
 */
export async function textToColumnsExact(
  spec: TextSpec,
): Promise<{ columns: LetterColumn[]; warnings: string[] } | null> {
  const out = textToOutlines(spec)
  if (!out.letters.length) return null
  const columns: LetterColumn[] = []
  const thin: string[] = []

  for (const letter of out.letters) {
    // Whitespace has no outline and nothing to fail at.
    if (!letter.paths.length || !letter.ch.trim()) continue
    const branches = await axisBranches(letter.paths)
    const before = columns.length
    for (const branch of branches ?? []) {
      const kept = trimAxis(branch)
      if (!kept) continue
      const rails = railsFromAxis(kept)
      if (rails.left.length < 3) { thin.push(letter.ch); continue }
      columns.push({ ch: letter.ch, left: rails.left, right: rails.right })
    }
    // ALL THE LETTERS OR NONE.
    //
    // Skipping a letter the axis cannot do leaves a WORD WITH A HOLE IN IT,
    // and that is exactly what shipped: "Test" came back with its T and its
    // t and no e or s, because those two letters failed and the rest
    // succeeded, so nothing fell back. A word half-converted is worse than a
    // word converted by the rougher engine, because the rougher engine at
    // least produces every letter.
    if (columns.length === before) return null
  }

  if (!columns.length) return null

  const warnings = [...out.warnings]
  if (thin.length) {
    warnings.push(`${thin.length} stroke(s) were too thin for satin (in “${[...new Set(thin)].join('')}”) — a heavier face or a larger size`)
  }
  return { columns, warnings }
}
