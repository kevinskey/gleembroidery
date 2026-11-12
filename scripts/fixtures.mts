// Generate the spec §11 fixture designs: a .dst export plus a .intended.json
// describing what the stitch plan was SUPPOSED to be.
//
// scripts/independent-check.py then reads the .dst back with pyembroidery — a
// separate implementation by other authors — and compares. That is the check
// spec §8 asks for: our own reader agreeing with our own writer proves only
// that we are self-consistent.
//
//   npx tsx scripts/fixtures.mts

import { mkdirSync, writeFileSync } from 'node:fs'
import { centerPlan, digitize } from '../src/digitize'
import { writeDst } from '../src/dst'
import { writeCol, writeEdr } from '../src/package'
import { emptyDoc, newObject, type EmbObject, type Pt } from '../src/model'
import { planBounds } from '../src/stitches'

const OUT = new URL('../fixtures/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

const circle = (cx: number, cy: number, r: number, n = 128): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  })

const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n = 64): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  })

const rect = (x: number, y: number, w: number, h: number): Pt[] => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y },
]

/** Affine transform, so a fixture can be resized and rotated before export. */
function xf(paths: Pt[][], scale: number, deg: number): Pt[][] {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r), s = Math.sin(r)
  return paths.map((p) => p.map((q) => ({
    x: (q.x * c - q.y * s) * scale,
    y: (q.x * s + q.y * c) * scale,
  })))
}

interface Fixture { name: string; note: string; objects: EmbObject[] }

const FIXTURES: Fixture[] = [
  {
    name: 'hole-fill',
    note: 'Filled shape with an internal hole (spec §11)',
    objects: [newObject({
      name: 'ring', color: '#c0392b', type: 'fill',
      paths: [circle(0, 0, 20), circle(0, 0, 8)],
    })],
  },
  {
    name: 'curved-satin',
    note: 'Curved satin letter stroke — a C (spec §11)',
    objects: [newObject({
      name: 'C', color: '#1f6feb', type: 'satin',
      paths: [arc(0, 0, 15, Math.PI * 0.3, Math.PI * 1.7)],
      satin: { width: 3, density: 0.4, pullComp: 0.2, underlay: 'center' },
    })],
  },
  {
    name: 'narrow-and-corner',
    note: 'Narrow satin region and a sharp corner (spec §11)',
    objects: [
      newObject({
        name: 'narrow', color: '#16a34a', type: 'satin',
        paths: [[{ x: -20, y: -10 }, { x: 0, y: -10 }, { x: 20, y: -10 }]],
        satin: { width: 1.0, density: 0.35, pullComp: 0.15, underlay: 'center' },
      }),
      newObject({
        name: 'chevron', color: '#16a34a', type: 'satin',
        // A 40-degree included angle — tight enough to pile thread at the apex.
        paths: [[{ x: -15, y: 12 }, { x: 0, y: -8 }, { x: 15, y: 12 }]],
        satin: { width: 3.5, density: 0.4, pullComp: 0.2, underlay: 'center' },
      }),
    ],
  },
  {
    name: 'overlap-two-colours',
    note: 'Overlapping objects with different thread colours (spec §11)',
    objects: [
      newObject({ name: 'back', color: '#d97706', type: 'fill', paths: [rect(-20, -12, 28, 24)] }),
      newObject({ name: 'front', color: '#7c3aed', type: 'fill', paths: [circle(8, 0, 12)] }),
    ],
  },
  {
    name: 'resized-rotated',
    note: 'Design resized 1.6x and rotated 30 degrees before export (spec §11)',
    objects: [newObject({
      name: 'xf-ring', color: '#0891b2', type: 'fill',
      paths: xf([circle(0, 0, 12), circle(0, 0, 5)], 1.6, 30),
    })],
  },
]

// Every other fixture is centred, which makes every header symmetric and
// leaves the +Y/-Y polarity structurally untestable. This one is deliberately
// off-centre and asymmetric in both axes.
const ASYMMETRIC = 'offcentre-asymmetric'
FIXTURES.push({
  name: ASYMMETRIC,
  note: 'Off-centre and asymmetric, so +X != -X and +Y != -Y (spec §8 orientation)',
  objects: [
    newObject({ name: 'low-left', color: '#c0392b', type: 'fill', paths: [rect(-30, 5, 14, 9)] }),
    newObject({ name: 'high-right', color: '#1f6feb', type: 'run',
      paths: [[{ x: 4, y: -22 }, { x: 26, y: -22 }, { x: 26, y: -8 }]] }),
  ],
})

const index: Record<string, unknown>[] = []

for (const f of FIXTURES) {
  const doc = emptyDoc()
  doc.name = f.name
  doc.objects = f.objects
  const { plan, warnings } = digitize(doc)
  const centered = f.name === ASYMMETRIC ? plan : centerPlan(plan)
  const bytes = writeDst(centered, f.name)
  writeFileSync(`${OUT}${f.name}.dst`, bytes)
  // Colour sidecars travel with the machine file: DST carries no colour.
  writeFileSync(`${OUT}${f.name}.col`, writeCol(centered))
  writeFileSync(`${OUT}${f.name}.edr`, writeEdr(centered))

  const bb = planBounds(centered)!
  const penetrations = centered.blocks.flatMap((b) => b.stitches).filter((s) => !s.jump)
  const intended = {
    name: f.name,
    note: f.note,
    colorBlocks: centered.blocks.length,
    colors: centered.blocks.map((b) => b.color),
    colorChanges: centered.blocks.length - 1,
    penetrationCount: penetrations.length,
    widthMm: +bb.widthMm.toFixed(3),
    heightMm: +bb.heightMm.toFixed(3),
    minXmm: +bb.minX.toFixed(3), maxXmm: +bb.maxX.toFixed(3),
    minYmm: +bb.minY.toFixed(3), maxYmm: +bb.maxY.toFixed(3),
    warnings,
    // Y is DOWN here, as everywhere above the DST writer.
    penetrations: penetrations.map((s) => [+s.x.toFixed(3), +s.y.toFixed(3)]),
  }
  writeFileSync(`${OUT}${f.name}.intended.json`, JSON.stringify(intended))
  index.push({ name: f.name, note: f.note, stitches: penetrations.length, bytes: bytes.length })
  console.log(
    `${f.name.padEnd(22)} ${String(penetrations.length).padStart(6)} penetrations  ` +
      `${bb.widthMm.toFixed(1)} x ${bb.heightMm.toFixed(1)} mm  ${bytes.length} bytes` +
      (warnings.length ? `  [${warnings.length} warning(s)]` : ''),
  )
}

writeFileSync(`${OUT}index.json`, JSON.stringify(index, null, 1))
console.log(`\n${FIXTURES.length} fixtures written to fixtures/`)
