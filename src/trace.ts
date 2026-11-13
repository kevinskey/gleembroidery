// Auto-trace: turn a region of a raster image into stitchable outlines.
//
// This is the "magic wand" of a digitizing package. The operator loads the
// customer's logo as a backdrop, clicks a colour, and gets an object whose
// outline follows that colour — which is how most real jobs start, because
// what arrives in the inbox is a PNG, not vectors.
//
// DOM-FREE by contract: it takes raw RGBA bytes, so the whole thing runs in
// the headless suite. App.tsx does the image loading.
//
// Two steps, deliberately separate:
//   1. a flood fill from the clicked pixel, by colour similarity, giving a
//      binary mask;
//   2. marching squares over that mask, giving closed contours.
// Marching squares rather than boundary-following because it produces the
// holes for free, as their own loops, and the existing toRegions() already
// knows how to nest a pile of loops into outer-plus-holes.

import { simplify } from './vector'
import type { Pt } from './model'

export interface Raster {
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8ClampedArray | Uint8Array
  width: number
  height: number
}

/**
 * How far a pixel may differ from the clicked colour and still be included,
 * as a fraction of the maximum possible distance.
 *
 * Compared in plain RGB with an alpha gate. Perceptual spaces would be more
 * principled, but the user adjusts this by eye against a live preview, and a
 * number they can calibrate beats a number that is theoretically better.
 */
export const DEFAULT_TOLERANCE = 0.18

/** Largest image we will trace, in pixels. */
export const MAX_TRACE_PIXELS = 16_000_000

function colourAt(img: Raster, i: number): [number, number, number, number] {
  const d = img.data
  return [d[i], d[i + 1], d[i + 2], d[i + 3]]
}

/**
 * Flood from a pixel, collecting everything within `tolerance` of its colour.
 *
 * Four-connected and iterative. A recursive fill blows the stack on anything
 * bigger than a thumbnail, and eight-connectivity lets the mask leak through
 * single-pixel diagonal gaps — which in a JPEG-compressed logo is most
 * diagonal edges.
 */
export function floodMask(img: Raster, sx: number, sy: number, tolerance = DEFAULT_TOLERANCE): Uint8Array {
  const { width: w, height: h } = img
  const mask = new Uint8Array(w * h)
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask

  const start = (sy * w + sx) * 4
  const [r0, g0, b0, a0] = colourAt(img, start)
  // 255*sqrt(3) is the furthest two opaque colours can be apart.
  const limit = tolerance * 441.673
  const stack = [sy * w + sx]
  mask[sy * w + sx] = 1

  while (stack.length) {
    const p = stack.pop()!
    const x = p % w, y = (p - x) / w
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const np = ny * w + nx
      if (mask[np]) continue
      const i = np * 4
      const [r, g, b, a] = colourAt(img, i)
      // Transparency is its own kind of difference: a transparent pixel is
      // not "a pale version" of the colour, it is absent. Comparing RGB
      // underneath alpha would flood straight through a logo's background.
      if (Math.abs(a - a0) > 128) continue
      if (a0 < 8 && a < 8) { mask[np] = 1; stack.push(np); continue }
      const d = Math.hypot(r - r0, g - g0, b - b0)
      if (d > limit) continue
      mask[np] = 1
      stack.push(np)
    }
  }
  return mask
}

/** How many pixels a mask covers. */
export function maskArea(mask: Uint8Array): number {
  let n = 0
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++
  return n
}

const key = (x: number, y: number) => `${x.toFixed(1)},${y.toFixed(1)}`

/**
 * Marching squares over a binary mask, returning closed contours in pixel
 * coordinates.
 *
 * Contours run on the half-grid between pixels, which is where the boundary
 * actually is — snapping them to pixel centres would shrink every shape by
 * half a pixel and, on a 2 mm letter stem, that is a visible error.
 *
 * The ambiguous saddle cases (5 and 10) are resolved CONSISTENTLY rather than
 * by majority: an inconsistent choice makes two contours touch at a point,
 * and a pinch point is not something the fill engine can sew.
 */
export function maskContours(mask: Uint8Array, w: number, h: number): Pt[][] {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x])
  // Each marching-squares cell emits segments; they are linked into loops by
  // matching endpoints.
  const from = new Map<string, Pt[]>()
  const push = (a: Pt, b: Pt) => {
    const k = key(a.x, a.y)
    const list = from.get(k)
    if (list) list.push(b); else from.set(k, [b])
  }

  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const tl = at(x, y), tr = at(x + 1, y), bl = at(x, y + 1), br = at(x + 1, y + 1)
      const c = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0)
      if (c === 0 || c === 15) continue
      // Edge midpoints of this cell, on the half-grid.
      const N = { x: x + 0.5, y: y + 0.0 }
      const E = { x: x + 1.0, y: y + 0.5 }
      const S = { x: x + 0.5, y: y + 1.0 }
      const W = { x: x + 0.0, y: y + 0.5 }
      // Wound so the filled side is consistently on one hand, which is what
      // lets toRegions tell an outer boundary from a hole by its area sign.
      switch (c) {
        case 1: push(W, S); break
        case 2: push(S, E); break
        case 3: push(W, E); break
        case 4: push(E, N); break
        case 5: push(W, N); push(E, S); break
        case 6: push(S, N); break
        case 7: push(W, N); break
        case 8: push(N, W); break
        case 9: push(N, S); break
        case 10: push(N, E); push(S, W); break
        case 11: push(N, E); break
        case 12: push(E, W); break
        case 13: push(E, S); break
        case 14: push(S, W); break
      }
    }
  }

  const loops: Pt[][] = []
  const used = new Set<string>()
  for (const [startKey, firsts] of from) {
    for (const first of firsts) {
      const edge = `${startKey}>${key(first.x, first.y)}`
      if (used.has(edge)) continue
      const loop: Pt[] = []
      let cur: Pt = { x: parseFloat(startKey.split(',')[0]), y: parseFloat(startKey.split(',')[1]) }
      let next: Pt | null = first
      let guard = 0
      while (next && guard++ < 4_000_000) {
        const e = `${key(cur.x, cur.y)}>${key(next.x, next.y)}`
        if (used.has(e)) break
        used.add(e)
        loop.push(cur)
        cur = next
        const outs = from.get(key(cur.x, cur.y))
        next = outs ? outs.find((q) => !used.has(`${key(cur.x, cur.y)}>${key(q.x, q.y)}`)) ?? null : null
      }
      if (loop.length >= 3) loops.push(loop)
    }
  }
  return loops
}

export interface TraceResult {
  /** Contours in MILLIMETRES, ready to become an object's paths. */
  paths: Pt[][]
  /** Pixels the flood covered, so the caller can report a miss. */
  area: number
  warnings: string[]
}

export interface TraceOptions {
  tolerance?: number
  /** Pixels per millimetre, to convert the contours as they come out. */
  pxPerMm?: number
  /** Top-left of the image in document mm. */
  originMm?: Pt
  /** Simplification tolerance in mm. */
  simplifyMm?: number
  /** Contours enclosing fewer pixels than this are dropped as speckle. */
  minAreaPx?: number
}

/**
 * Trace the region of `img` containing pixel (sx, sy).
 *
 * The contours come back simplified and in millimetres. Simplification is not
 * cosmetic: a raw marching-squares contour has a vertex every half pixel, and
 * a 300 px logo would arrive as tens of thousands of points for the fill
 * engine to chew through on every parameter change.
 */
export function traceRegionAt(img: Raster, sx: number, sy: number, opt: TraceOptions = {}): TraceResult {
  const warnings: string[] = []
  const { width: w, height: h } = img
  if (w * h > MAX_TRACE_PIXELS) {
    return { paths: [], area: 0, warnings: [`image is ${w}x${h}; scale it down before tracing`] }
  }
  const mask = floodMask(img, Math.round(sx), Math.round(sy), opt.tolerance ?? DEFAULT_TOLERANCE)
  const area = maskArea(mask)
  if (area === 0) return { paths: [], area: 0, warnings: ['nothing was selected there'] }

  const pxPerMm = opt.pxPerMm && opt.pxPerMm > 0 ? opt.pxPerMm : 1
  const origin = opt.originMm ?? { x: 0, y: 0 }
  const simplifyMm = opt.simplifyMm ?? 0.2
  const minAreaPx = opt.minAreaPx ?? 12

  const loops = maskContours(mask, w, h)
  const paths: Pt[][] = []
  let dropped = 0
  for (const loop of loops) {
    // Shoelace in PIXELS, before any scaling, so the speckle threshold means
    // the same thing whatever the image resolution.
    let a2 = 0
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i], q = loop[(i + 1) % loop.length]
      a2 += p.x * q.y - q.x * p.y
    }
    if (Math.abs(a2 / 2) < minAreaPx) { dropped++; continue }
    const mm = loop.map((p) => ({ x: origin.x + p.x / pxPerMm, y: origin.y + p.y / pxPerMm }))
    const thin = simplify(mm, simplifyMm)
    if (thin.length >= 3) paths.push(thin)
  }
  if (dropped) warnings.push(`${dropped} speck${dropped === 1 ? '' : 's'} too small to sew were dropped`)
  if (!paths.length) warnings.push('the traced area was too small to sew')
  return { paths, area, warnings }
}
