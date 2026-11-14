import type { Pt } from './model'

// ---------------------------------------------------------------------------
// SVG -> cut lines. Every geometry element in the file (path, rect, circle,
// ellipse, line, polyline, polygon) is flattened into millimetre polylines
// that the plotter can draw with M/D (GP-GL) or PU/PD (HP-GL) commands.
//
// The browser does the hard part: the SVG is parsed into a hidden <svg>, so
// transforms, nested groups, viewBox scaling and units are resolved with the
// real CTM, and curves are sampled with getPointAtLength. Each subpath of a
// <path> (every M/m) becomes its own polyline so no line is drawn across the
// pen-up gap between them.
// ---------------------------------------------------------------------------

export interface VectorImport {
  name: string
  paths: Pt[][] // mm, normalised so the bounding box starts at (0,0)
  /**
   * The fill colour of each path, '#rrggbb', parallel to `paths`.
   *
   * An SVG logo already says what colour everything is, and that is the
   * whole answer to "which thread". Dealing out a rotating palette instead
   * turned a three-colour crest into thirty thread changes — the colours
   * were in the file the entire time.
   */
  colors: string[]
  widthMm: number
  heightMm: number
  skipped: number // elements that could not be flattened (text, images…)
}

const UNIT_MM: Record<string, number> = {
  mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96,
}

function lengthToMm(v: string | null): number | null {
  if (!v) return null
  const m = /^\s*([0-9.+-eE]+)\s*([a-z%]*)\s*$/.exec(v)
  if (!m || m[2] === '%') return null
  const k = UNIT_MM[m[2]]
  return k == null ? null : parseFloat(m[1]) * k
}

const SKIP_PARENTS = new Set(['defs', 'clipPath', 'mask', 'symbol', 'pattern', 'marker', 'metadata', 'title', 'desc'])
const GEOMETRY = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'])

/**
 * The colour an element will be stitched in.
 *
 * Fill first, then stroke: a shape with no fill is an outline, and its
 * stroke colour is the only colour it has. Anything unreadable — a
 * gradient, a pattern, currentColor against nothing — falls back to black
 * rather than to a random palette entry, because black is an honest "we
 * could not tell" that the user will notice and change, where a cheerful
 * magenta looks deliberate.
 */
function elementColour(cs: CSSStyleDeclaration): string {
  const pick = (v: string): string | null => {
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)$/.exec(v.trim())
    if (!m) return null
    // Fully transparent is not a colour: a fill:none rect is a frame, and
    // its stroke is what gets sewn.
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null
    const hex = (x: string) => Number(x).toString(16).padStart(2, '0')
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`
  }
  return pick(cs.fill) ?? pick(cs.stroke) ?? '#000000'
}

function insideSkipped(el: Element, root: Element): boolean {
  for (let p = el.parentElement; p && p !== root; p = p.parentElement)
    if (SKIP_PARENTS.has(p.tagName.toLowerCase())) return true
  return false
}

// Ramer–Douglas–Peucker, so a 10 000-point sampled curve becomes a few
// hundred segments the cutter cannot tell apart from the original.
// Exported for the image tracer, which smooths then thins its contours.
export function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    const A = pts[a], B = pts[b]
    const dx = B.x - A.x, dy = B.y - A.y
    const len2 = dx * dx + dy * dy
    let worst = -1, worstD = tol
    for (let i = a + 1; i < b; i++) {
      const P = pts[i]
      let d: number
      if (len2 === 0) d = Math.hypot(P.x - A.x, P.y - A.y)
      else {
        const t = Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2))
        d = Math.hypot(P.x - (A.x + t * dx), P.y - (A.y + t * dy))
      }
      if (d > worstD) { worstD = d; worst = i }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]) }
  }
  return pts.filter((_, i) => keep[i])
}

// Lengths at which each subpath of a <path> ends, so one path's subpaths can
// be sampled separately along the whole path's length.
function subpathEnds(el: SVGGeometryElement): number[] {
  if (el.tagName.toLowerCase() !== 'path') return [el.getTotalLength()]
  const d = el.getAttribute('d') ?? ''
  const parts = d.match(/[Mm][^Mm]*/g)
  if (!parts || parts.length < 2) return [el.getTotalLength()]
  const probe = el.cloneNode(false) as SVGPathElement
  el.parentNode!.appendChild(probe)
  const ends: number[] = []
  for (let k = 1; k <= parts.length; k++) {
    probe.setAttribute('d', parts.slice(0, k).join(''))
    ends.push(probe.getTotalLength())
  }
  probe.remove()
  return ends
}

export function parseSvgToPaths(svgText: string, name = 'vector'): VectorImport {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const root = doc.querySelector('svg')
  if (!root || doc.querySelector('parsererror')) throw new Error('Not a readable SVG file')

  // Work in a hidden copy so getCTM / getPointAtLength are available.
  const host = document.createElement('div')
  // offscreen + transparent, NOT visibility:hidden — that inherits into every
  // child and would read as "hidden" below
  host.style.cssText = 'position:absolute;left:-100000px;top:0;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none'
  const svg = document.importNode(root, true) as SVGSVGElement
  host.appendChild(svg)
  document.body.appendChild(host)
  try {
    // user units -> mm: from a physical width/height if the file has one,
    // else CSS pixels at 96 dpi (what Illustrator/Inkscape mean by unitless).
    const vb = svg.viewBox?.baseVal
    let vbX = 0, vbY = 0, vbW = 0, vbH = 0
    if (vb && vb.width > 0 && vb.height > 0) { vbX = vb.x; vbY = vb.y; vbW = vb.width; vbH = vb.height }
    const wMm = lengthToMm(root.getAttribute('width'))
    const hMm = lengthToMm(root.getAttribute('height'))
    if (!vbW) { vbW = wMm != null ? wMm / UNIT_MM.px : 100; vbH = hMm != null ? hMm / UNIT_MM.px : 100 }
    const mmPerUnit = wMm != null && vbW ? wMm / vbW : hMm != null && vbH ? hMm / vbH : UNIT_MM.px
    // give the hidden svg a 1:1 viewport so the CTM maths stays simple
    svg.setAttribute('width', String(vbW))
    svg.setAttribute('height', String(vbH))
    svg.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`)
    svg.setAttribute('preserveAspectRatio', 'none')
    const rootInv = svg.getScreenCTM()?.inverse()
    if (!rootInv) throw new Error('Could not measure the SVG')

    const stepMm = 0.15 // sampling step along curves, before simplification
    const paths: Pt[][] = []
    const colors: string[] = []
    let skipped = 0
    const all = Array.from(svg.querySelectorAll('*'))
    for (const el of all) {
      const tag = el.tagName.toLowerCase()
      if (tag === 'text' || tag === 'image' || tag === 'use') { if (!insideSkipped(el, svg)) skipped++; continue }
      if (!GEOMETRY.has(tag) || insideSkipped(el, svg)) continue
      const g = el as SVGGeometryElement
      const cs = getComputedStyle(g)
      if (cs.display === 'none' || g.getAttribute('visibility') === 'hidden' || g.style.visibility === 'hidden') continue
      const ctm = g.getScreenCTM()
      if (!ctm) continue
      const m = rootInv.multiply(ctm) // element user space -> root viewBox units
      const unitScale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1
      const toMm = (x: number, y: number): Pt => ({
        x: (m.a * x + m.c * y + m.e - vbX) * mmPerUnit,
        y: (m.b * x + m.d * y + m.f - vbY) * mmPerUnit,
      })
      let total: number
      try { total = g.getTotalLength() } catch { skipped++; continue }
      if (!isFinite(total) || total <= 0) continue
      const ends = subpathEnds(g)
      let start = 0
      for (const end of ends) {
        const len = end - start
        if (len <= 0) { start = end; continue }
        const stepU = stepMm / (mmPerUnit * unitScale)
        const n = Math.min(20000, Math.max(1, Math.ceil(len / stepU)))
        const pts: Pt[] = []
        // A subpath opens with a zero-length moveto, so the position at
        // EXACTLY `start` is still the previous subpath's last point — for
        // "M25 30 m-16 0 a…" that is the circle's centre, not its rim.
        // Sampling from a hair past the start lands on the subpath proper.
        // Without this a ring comes back with a spike to the moveto origin,
        // its ends 16 mm apart, and it never reads as closed — so a letter
        // counter is filled in solid instead of being left as a hole.
        const eps = Math.min(len * 1e-4, 1e-3)
        const from = start + eps
        const span = end - from
        for (let i = 0; i <= n; i++) {
          const p = g.getPointAtLength(from + (span * i) / n)
          const q = toMm(p.x, p.y)
          const last = pts[pts.length - 1]
          if (!last || Math.hypot(q.x - last.x, q.y - last.y) > 1e-4) pts.push(q)
        }
        start = end
        const s = simplify(pts, 0.03)
        if (s.length >= 2) { paths.push(s); colors.push(elementColour(cs)) }
      }
    }
    if (!paths.length) throw new Error(skipped ? 'No cuttable shapes — the file is text or images only. Convert text to outlines first.' : 'No shapes found in this SVG')
    // normalise to a (0,0) top-left corner
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of paths) for (const q of p) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y) }
    const out = paths.map((p) => p.map((q) => ({ x: q.x - minX, y: q.y - minY })))
    return { name, paths: out, colors, widthMm: maxX - minX, heightMm: maxY - minY, skipped }
  } finally {
    host.remove()
  }
}

// Path data for the on-screen preview of a set of polylines (1 unit = 1 mm).
export function pathsToD(paths: Pt[][]): string {
  return paths
    .map((p) => 'M' + p.map((q) => `${q.x.toFixed(2)},${q.y.toFixed(2)}`).join('L'))
    .join('')
}

// Distance from a point to the nearest segment of any polyline (mm).
export function distToPaths(paths: Pt[][], p: Pt): number {
  let best = Infinity
  for (const poly of paths) {
    for (let i = 1; i < poly.length; i++) {
      const A = poly[i - 1], B = poly[i]
      const dx = B.x - A.x, dy = B.y - A.y
      const len2 = dx * dx + dy * dy
      const t = len2 ? Math.max(0, Math.min(1, ((p.x - A.x) * dx + (p.y - A.y) * dy) / len2)) : 0
      const d = Math.hypot(p.x - (A.x + t * dx), p.y - (A.y + t * dy))
      if (d < best) best = d
    }
  }
  return best
}
