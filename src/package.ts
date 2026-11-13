// The production package: everything that leaves with the .dst.
//
// A DST carries needle movement and nothing else — no colours, no thread
// numbers, no object structure, no stop semantics distinct from a colour
// change. Handing an operator a bare .dst for a four-colour job means handing
// them four unlabelled blocks and asking them to guess the order. So the
// export is a PACKAGE:
//
//   design.dst          the machine file
//   design.col/.edr     colour sidecars, read by most machine software
//   run sheet           what to thread, in what order, with stitch counts
//   placement template  printed 1:1, with centre crosshairs for hooping
//
// Formats here match pyembroidery's writers byte for byte (ColWriter.py,
// EdrWriter.py), so anything that reads those reads these.

import type { Doc, EmbObject } from './model'
import type { StitchPlan } from './stitches'
import { countTrims, planBounds } from './stitches'

export interface MachineProfile {
  /** Needles available. More colour blocks than needles means a re-thread. */
  needles: number
  /** Running speed, stitches per minute. 700 is typical for flat goods. */
  spm: number
  /** Seconds lost to one trim. */
  trimSeconds: number
  /** Seconds lost to one colour change (needle change on a multi-head). */
  colorChangeSeconds: number
}

export const DEFAULT_MACHINE: MachineProfile = {
  needles: 12,
  spm: 700,
  trimSeconds: 3,
  colorChangeSeconds: 8,
}

const hex = (c: string) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.trim())
  return m
    ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
    : { r: 0, g: 0, b: 0 }
}

// ---------------------------------------------------------------------------
// Colour sidecars
// ---------------------------------------------------------------------------

/** Barudan/Hirsch .col — a line count, then `index,R,G,B` per thread. */
export function writeCol(plan: StitchPlan): string {
  let out = `${plan.blocks.length}\r\n`
  plan.blocks.forEach((b, i) => {
    const { r, g, b: bl } = hex(b.color)
    out += `${i},${r},${g},${bl}\r\n`
  })
  return out
}

/** Embird .edr — four bytes per thread: R, G, B, 0. */
export function writeEdr(plan: StitchPlan): Uint8Array {
  const out = new Uint8Array(plan.blocks.length * 4)
  plan.blocks.forEach((b, i) => {
    const { r, g, b: bl } = hex(b.color)
    out[i * 4] = r
    out[i * 4 + 1] = g
    out[i * 4 + 2] = bl
    out[i * 4 + 3] = 0
  })
  return out
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export interface BlockStat {
  index: number
  label: string
  color: string
  thread: string
  stitches: number
  jumps: number
  trims: number
  /** Minutes, this block alone. */
  minutes: number
}

export interface PackageStats {
  blocks: BlockStat[]
  stitches: number
  jumps: number
  trims: number
  colorChanges: number
  widthMm: number
  heightMm: number
  minutes: number
  warnings: string[]
}

function threadLabel(objects: EmbObject[], label: string): string {
  // A block's label is built from the object names it merged, so match on the
  // first one; an unassigned thread says so rather than showing a hex code the
  // operator cannot look up.
  const first = label.split(' + ')[0]
  const obj = objects.find((o) => o.name === first)
  const t = obj?.thread
  if (!t || (!t.code && !t.name)) return 'UNASSIGNED'
  return [t.brand, t.code, t.name].filter(Boolean).join(' ')
}

export function packageStats(
  doc: Doc,
  plan: StitchPlan,
  warnings: string[],
  machine: MachineProfile = DEFAULT_MACHINE,
): PackageStats {
  const blocks: BlockStat[] = plan.blocks.map((b, i) => {
    let stitches = 0, jumps = 0, trims = 0
    for (const s of b.stitches) {
      if (s.trim) trims++
      if (s.jump) jumps++
      else stitches++
    }
    // Jump records cost machine cycles too — the head moves for each one —
    // and a trim is at least three of them, so charging nothing for jumps
    // under-estimated trim-heavy files twice over.
    const minutes =
      (stitches + jumps) / machine.spm +
      (trims * machine.trimSeconds) / 60 +
      (i > 0 ? machine.colorChangeSeconds / 60 : 0)
    return {
      index: i + 1,
      label: b.label,
      color: b.color,
      thread: threadLabel(doc.objects, b.label),
      stitches,
      jumps,
      trims,
      minutes,
    }
  })

  const bb = planBounds(plan)
  const all = blocks.reduce(
    (a, b) => ({ s: a.s + b.stitches, j: a.j + b.jumps, m: a.m + b.minutes }),
    { s: 0, j: 0, m: 0 },
  )

  const extra: string[] = []
  if (plan.blocks.length > machine.needles)
    extra.push(
      `${plan.blocks.length} colour blocks on a ${machine.needles}-needle machine — ` +
        `the operator must re-thread mid-run.`,
    )
  if (blocks.some((b) => b.thread === 'UNASSIGNED'))
    extra.push('Some blocks have no thread assigned — the run sheet will say UNASSIGNED.')

  return {
    blocks,
    stitches: all.s,
    jumps: all.j,
    trims: countTrims(plan),
    colorChanges: Math.max(0, plan.blocks.length - 1),
    widthMm: bb?.widthMm ?? 0,
    heightMm: bb?.heightMm ?? 0,
    minutes: all.m,
    warnings: [...warnings, ...extra],
  }
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * A colour safe to drop into a CSS property. HTML escaping does not make a
 * value safe inside `style="..."`, and a colour can arrive from a project
 * file rather than from the colour picker.
 */
const cssColor = (c: string) => (/^#[0-9a-f]{6}$/i.test(c.trim()) ? c.trim() : '#000000')

const mmIn = (mm: number) => `${mm.toFixed(1)} mm (${(mm / 25.4).toFixed(2)}")`

// ---------------------------------------------------------------------------
// Run sheet
// ---------------------------------------------------------------------------

export function runSheetHtml(doc: Doc, stats: PackageStats, machine = DEFAULT_MACHINE): string {
  const rows = stats.blocks
    .map(
      (b) => `<tr>
      <td class="n">${b.index}</td>
      <td><span class="sw" style="background:${cssColor(b.color)}"></span>${esc(b.color)}</td>
      <td class="${b.thread === 'UNASSIGNED' ? 'warn' : ''}">${esc(b.thread)}</td>
      <td>${esc(b.label)}</td>
      <td class="n">${b.stitches.toLocaleString()}</td>
      <td class="n">${b.trims}</td>
      <td class="n">${b.minutes.toFixed(1)}</td>
    </tr>`,
    )
    .join('\n')

  const warn = stats.warnings.length
    ? `<div class="warnbox"><strong>Check before running</strong><ul>${stats.warnings
        .map((w) => `<li>${esc(w)}</li>`)
        .join('')}</ul></div>`
    : ''

  return `<!doctype html><meta charset="utf-8">
<title>Run sheet — ${esc(doc.name)}</title>
<style>
  body { font: 12pt/1.4 -apple-system, system-ui, sans-serif; margin: 18mm; color: #111 }
  h1 { font-size: 18pt; margin: 0 0 2mm }
  .sub { color: #555; margin-bottom: 6mm }
  table { border-collapse: collapse; width: 100% }
  th, td { border-bottom: 1px solid #ccc; padding: 2mm 1.5mm; text-align: left; vertical-align: top }
  th { font-size: 9pt; text-transform: uppercase; letter-spacing: .04em; color: #555 }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums }
  .sw { display: inline-block; width: 10px; height: 10px; border: 1px solid #0006;
        margin-right: 5px; vertical-align: middle }
  .warn { color: #b45309; font-weight: 600 }
  .warnbox { border: 1.5px solid #b45309; padding: 3mm 4mm; margin: 5mm 0; border-radius: 2mm }
  .warnbox ul { margin: 2mm 0 0; padding-left: 5mm }
  dl { display: grid; grid-template-columns: auto auto; gap: 1mm 6mm; width: max-content }
  dt { color: #555 } dd { margin: 0; font-variant-numeric: tabular-nums }
  footer { margin-top: 8mm; font-size: 9pt; color: #666 }
  @media print { body { margin: 10mm } }
</style>
<h1>${esc(doc.name)}</h1>
<div class="sub">Colour sequence &middot; ${esc(doc.hoop.name)}</div>
${warn}
<table>
  <thead><tr>
    <th class="n">#</th><th>Colour</th><th>Thread</th><th>Objects</th>
    <th class="n">Stitches</th><th class="n">Trims</th><th class="n">Min</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
<p></p>
<dl>
  <dt>Design size</dt><dd>${mmIn(stats.widthMm)} &times; ${mmIn(stats.heightMm)}</dd>
  <dt>Hoop sewing field</dt><dd>${mmIn(doc.hoop.widthMm)} &times; ${mmIn(doc.hoop.heightMm)}</dd>
  <dt>Total stitches</dt><dd>${stats.stitches.toLocaleString()}</dd>
  <dt>Jumps / trims</dt><dd>${stats.jumps.toLocaleString()} / ${stats.trims}</dd>
  <dt>Colour changes</dt><dd>${stats.colorChanges}</dd>
  <dt>Estimated run time</dt><dd>${stats.minutes.toFixed(1)} min at ${machine.spm} spm</dd>
</dl>
<footer>
  Run time is an estimate: stitches &divide; ${machine.spm} spm, plus ${machine.trimSeconds}s per trim
  and ${machine.colorChangeSeconds}s per colour change. It excludes hooping and setup.
  <br>Generated by gleEmbroidery. <strong>Not sew-tested</strong> unless noted on the job.
</footer>`
}

// ---------------------------------------------------------------------------
// 1:1 placement template
// ---------------------------------------------------------------------------

/**
 * A print-at-100% template: the design's stitches at true size, the hoop
 * field, and centre crosshairs to line up against the garment and the hoop.
 * Dimensions are given in mm so the printer renders physical size; a
 * measurement bar is included so a mis-scaled print is obvious at a glance.
 */
/**
 * Cutting outlines for every appliqué object, at TRUE SIZE.
 *
 * The operator cuts fabric to this and lays it against the placement run, so
 * it is drawn from the SAME outline the placement run was generated from —
 * a cut file derived from anything else would be trimming to a line the
 * machine never sewed.
 *
 * Returns null when the design has no appliqué, so nothing empty is written.
 */
export function appliqueCutSvg(doc: Doc): string | null {
  const objs = doc.objects.filter((o) => o.type === 'applique' && o.visible && o.paths.length)
  if (!objs.length) return null

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const o of objs) for (const r of o.paths) for (const q of r) {
    if (q.x < minX) minX = q.x
    if (q.y < minY) minY = q.y
    if (q.x > maxX) maxX = q.x
    if (q.y > maxY) maxY = q.y
  }
  const pad = 10
  const w = maxX - minX + pad * 2
  const h = maxY - minY + pad * 2

  const shapes = objs.map((o) => {
    const d = o.paths.map((r) =>
      r.map((q, i) => `${i ? 'L' : 'M'}${(q.x - minX + pad).toFixed(3)} ${(q.y - minY + pad).toFixed(3)}`)
        .join(' ') + ' Z').join(' ')
    // Cut lines are hairlines with no fill: a filled shape printed solid
    // wastes toner and hides the line being cut to.
    return `<path d="${d}" fill="none" stroke="#000" stroke-width="0.2"/>`
      + `<text x="${(pad).toFixed(1)}" y="${(pad - 3).toFixed(1)}" font-size="4" fill="#000">${esc(o.name)}</text>`
  }).join('\n  ')

  // width/height in mm with a matching viewBox is what makes a printer put
  // this on paper at the size the fabric has to be.
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(2)}mm" height="${h.toFixed(2)}mm" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}">
  <title>${esc(doc.name)} — appliqué cutting outlines (true size)</title>
  ${shapes}
</svg>`
}

export function placementTemplateSvg(doc: Doc, plan: StitchPlan): string {
  const hw = doc.hoop.widthMm, hh = doc.hoop.heightMm
  const pad = 12
  // The page must contain the DESIGN, not just the hoop. A design larger than
  // the hoop was being cropped by the viewBox and printed silently — the
  // operator would hoop from a sheet showing part of the artwork.
  const b = planBounds(plan)
  const needW = b ? Math.max(Math.abs(b.minX), Math.abs(b.maxX)) * 2 : 0
  const needH = b ? Math.max(Math.abs(b.minY), Math.abs(b.maxY)) * 2 : 0
  const w = Math.max(hw, needW) + pad * 2
  const h = Math.max(hh, needH) + pad * 2
  const oversize = b ? needW > hw + 1e-6 || needH > hh + 1e-6 : false

  const paths = plan.blocks
    .map((b) => {
      let d = ''
      let pen = false
      for (const s of b.stitches) {
        if (s.jump) { pen = false; continue }
        d += `${pen ? 'L' : 'M'}${s.x.toFixed(2)},${s.y.toFixed(2)}`
        pen = true
      }
      return d ? `<path d="${d}" fill="none" stroke="${cssColor(b.color)}" stroke-width="0.35"/>` : ''
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm"
     viewBox="${-w / 2} ${-h / 2} ${w} ${h}">
  <title>${esc(doc.name)} — placement template, print at 100%</title>
  <rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" fill="#fff"/>
  <!-- hoop sewing field -->
  <rect x="${-hw / 2}" y="${-hh / 2}" width="${hw}" height="${hh}"
        fill="none" stroke="#999" stroke-width="0.4" stroke-dasharray="3 2"/>
  <!-- centre crosshairs: align these with the garment centre and hoop marks -->
  <path d="M${-hw / 2 - 6},0 H${hw / 2 + 6} M0,${-hh / 2 - 6} V${hh / 2 + 6}"
        stroke="#000" stroke-width="0.3"/>
  <circle cx="0" cy="0" r="2" fill="none" stroke="#000" stroke-width="0.3"/>
  ${paths}
  ${oversize ? `<text x="${-w / 2 + 6}" y="${-h / 2 + 8}" font-family="sans-serif" font-size="4.2" fill="#b00">
    WARNING: the design is larger than the ${esc(doc.hoop.name)} sewing field.</text>` : ''}
  <!-- scale check: this bar is exactly 50 mm. Measure it after printing. -->
  <g transform="translate(${-w / 2 + 6},${h / 2 - 6})">
    <path d="M0,0 H50 M0,-1.6 V1.6 M50,-1.6 V1.6 M25,-1 V1" stroke="#000" stroke-width="0.3"/>
    <text x="0" y="-3" font-family="sans-serif" font-size="3.2" fill="#000">50 mm — measure to confirm 100% print scale</text>
  </g>
</svg>`
}
