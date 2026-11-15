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
import { writeExp } from '../src/exp'
import { writeJef } from '../src/jef'
import { writeCol, writeEdr } from '../src/package'
import { RUN_STYLES, emptyDoc, newObject, type EmbObject, type Pt } from '../src/model'
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

/** One colour per style so a sewout can tell them apart on the cloth. */
const RUN_COLORS = ['#c0392b', '#1f6feb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777']

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
  {
    // The three program motifs, plus the satin column that started as a bug
    // report: a rectangle must come back FILLED with bars across it, not
    // outlined. Sew this one to judge knot height and eyelet hole size.
    name: 'program-and-column',
    note: 'French knots, candlewicking, an eyelet, and a satin column filling a rectangle',
    objects: [
      newObject({
        name: 'knots', color: '#c0392b', type: 'program',
        paths: [[{ x: -26, y: -16 }, { x: -18, y: -16 }, { x: -10, y: -16 }]],
        program: { kind: 'frenchknot', sizeMm: 3, holeMm: 1.5, passes: 7, spacingMm: 6 },
      }),
      newObject({
        name: 'candlewick', color: '#1f6feb', type: 'program',
        paths: [[{ x: -26, y: -6 }, { x: -2, y: -6 }]],
        program: { kind: 'candlewick', sizeMm: 2.5, holeMm: 1.5, passes: 7, spacingMm: 6 },
      }),
      newObject({
        name: 'eyelet', color: '#16a34a', type: 'program',
        paths: [circle(14, -12, 4)],
        program: { kind: 'eyelet', sizeMm: 7, holeMm: 2.5, passes: 10, spacingMm: 6 },
      }),
      newObject({
        name: 'column', color: '#7c3aed', type: 'satin',
        paths: [rect(-26, 4, 52, 8)],
        satin: {
          width: 2.5, density: 0.4, pullComp: 0.2, underlay: ['center'],
          lean: 0, mode: 'column', split: { enabled: false, maxLength: 6, stagger: 0.7 },
        },
      }),
    ],
  },
  {
    // A patch edge with real corners, and the three light appliqué finishes.
    // Sew this to judge whether the overhang actually encases a cut edge and
    // whether a fanned corner piles too much thread.
    name: 'patch-and-edges',
    note: 'Patch edge (fan and square corners) and the zigzag / blanket / E-stitch finishes',
    objects: [
      newObject({
        name: 'patch-fan', color: '#c0392b', type: 'patch',
        paths: [rect(-30, -18, 24, 14)],
        patch: { widthMm: 3, density: 0.35, overhangMm: 0.7, corner: 'fan' },
      }),
      newObject({
        name: 'patch-square', color: '#1f6feb', type: 'patch',
        paths: [rect(4, -18, 24, 14)],
        patch: { widthMm: 3, density: 0.35, overhangMm: 0.7, corner: 'square' },
      }),
      newObject({
        name: 'zigzag-edge', color: '#16a34a', type: 'run',
        paths: [[{ x: -30, y: 2 }, { x: 28, y: 2 }]],
        run: { length: 2.5, style: 'plain', passes: 3, widthMm: 1.4, gapMm: 2.5 },
      }),
      newObject({
        name: 'blanket-applique', color: '#7c3aed', type: 'applique',
        paths: [circle(-14, 14, 9)],
        applique: {
          tackWidth: 1.6, tackDensity: 0.5, borderWidth: 3,
          borderDensity: 0.4, borderPullComp: 0.2, border: true, borderStyle: 'blanket',
        },
      }),
      newObject({
        name: 'estitch-applique', color: '#d97706', type: 'applique',
        paths: [circle(12, 14, 9)],
        applique: {
          tackWidth: 1.6, tackDensity: 0.5, borderWidth: 3,
          borderDensity: 0.4, borderPullComp: 0.2, border: true, borderStyle: 'estitch',
        },
      }),
    ],
  },
  {
    // Freestanding lace and cross-stitch on the shared grid. THE LACE PANEL
    // IS THE ONE TO WASH-TEST: nothing in software can tell you whether a
    // mesh survives the sink.
    name: 'lace-and-counted',
    note: 'Freestanding lace mesh (diamond) and two cross-stitched shapes on one grid',
    objects: [
      newObject({
        name: 'lace-panel', color: '#c0392b', type: 'lace',
        paths: [circle(-16, 0, 15)],
        lace: { pattern: 'diamond', spacingMm: 2.5, angle: 0, passes: 3, borderPasses: 4 },
      }),
      newObject({
        name: 'counted-a', color: '#1f6feb', type: 'fill',
        paths: [rect(6, -14, 18, 12)],
        fill: { style: 'crossstitch', angle: 0, spacing: 0.4, length: 3, stagger: 0.5,
          crossPasses: 1, underlay: [], border: { enabled: false, width: 2, density: 0.4 } },
      }),
      newObject({
        // Deliberately NOT aligned to its neighbour's bounding box: the
        // crosses must still land on the same lattice.
        name: 'counted-b', color: '#16a34a', type: 'fill',
        paths: [rect(7.3, 2.6, 18, 12)],
        fill: { style: 'crossstitch', angle: 0, spacing: 0.4, length: 3, stagger: 0.5,
          crossPasses: 2, underlay: [], border: { enabled: false, width: 2, density: 0.4 } },
      }),
    ],
  },
  {
    // Hand-placed penetrations, deliberately including work the machine
    // cannot sew as given: six steps over 10 mm that must be subdivided, and
    // a 0.2 mm pair that must be dropped. 10 placed points leave as 22. The
    // point of the fixture is that the EXPORT obeys the machine while the
    // placed ORDER is preserved — no chaining, no reordering.
    name: 'manual-stitch',
    note: 'Hand-placed penetrations, with an overlong step and a double strike',
    objects: [newObject({
      name: 'hand', color: '#c0392b', type: 'manual',
      paths: [[
        { x: -24, y: -8 }, { x: -16, y: -12 }, { x: -8, y: -6 }, { x: 0, y: -14 },
        { x: 14, y: -14 },            // 14 mm — over the limit on purpose
        { x: 14.2, y: -14 },          // 0.2 mm — a second strike in one hole
        { x: 20, y: -4 }, { x: 10, y: 4 }, { x: -2, y: 2 }, { x: -14, y: 8 },
      ]],
    })],
  },
  {
    // Every run style on both a straight line and a curve, in one file. The
    // straight line makes the construction readable; the arc is where a
    // style that offsets sideways (stem, chain) can put thread where the
    // path never went. Each is its own colour so a sewout can be told apart.
    name: 'run-styles',
    note: 'Every run style, straight and curved — stage 1 of the digitizing tools',
    objects: RUN_STYLES.filter((s) => s !== 'motif').flatMap((style, i) => {
      const y = -24 + i * 7
      return [
        newObject({
          name: `${style}-straight`, color: RUN_COLORS[i % RUN_COLORS.length], type: 'run',
          paths: [[{ x: -30, y }, { x: -4, y }]],
          run: { length: 2.5, style, passes: 3, widthMm: 1.4, gapMm: 2.5 },
        }),
        newObject({
          name: `${style}-curve`, color: RUN_COLORS[i % RUN_COLORS.length], type: 'run',
          paths: [arc(16, y, 10, Math.PI, Math.PI * 1.9, 48)],
          run: { length: 2.5, style, passes: 3, widthMm: 1.4, gapMm: 2.5 },
        }),
      ]
    }),
  },
]


/**
 * THE SAMPLER (spec §6): every required stitch type on one hoop, with the
 * cases that break things — a curve, a variable-width column, a concave
 * fill, a hole that must stay empty, small detail near the floor, and patch
 * corners. This is the one to sew first.
 */
const SAMPLER = 'sampler'
FIXTURES.push({
  name: SAMPLER,
  note: 'Every stitch type on one hoop: curves, variable width, holes, small detail, patch corners',
  objects: [
    // Line types, left column.
    newObject({ name: 's-run', color: '#c0392b', type: 'run',
      paths: [arc(-44, -28, 9, Math.PI, Math.PI * 2, 40)],
      run: { length: 2.5, style: 'plain', passes: 3, widthMm: 1.4, gapMm: 2.5 } }),
    newObject({ name: 's-bean', color: '#c0392b', type: 'bean',
      paths: [[{ x: -53, y: -14 }, { x: -35, y: -14 }]],
      run: { length: 2.5, style: 'plain', passes: 3, widthMm: 1.4, gapMm: 2.5 } }),
    newObject({ name: 's-chain', color: '#c0392b', type: 'run',
      paths: [[{ x: -53, y: -9 }, { x: -35, y: -9 }]],
      run: { length: 3, style: 'chain', passes: 3, widthMm: 1.6, gapMm: 2.5 } }),
    newObject({ name: 's-sashiko', color: '#c0392b', type: 'run',
      paths: [[{ x: -53, y: -4 }, { x: -35, y: -4 }]],
      run: { length: 3, style: 'sashiko', passes: 3, widthMm: 1.4, gapMm: 2.5 } }),
    newObject({ name: 's-stem', color: '#c0392b', type: 'run',
      paths: [[{ x: -53, y: 1 }, { x: -35, y: 1 }]],
      run: { length: 3, style: 'stem', passes: 3, widthMm: 1.6, gapMm: 2.5 } }),

    // A CURVED satin border and a VARIABLE-WIDTH column (rails that taper).
    newObject({ name: 's-satin-curve', color: '#1f6feb', type: 'satin',
      paths: [arc(-20, -22, 11, Math.PI * 0.2, Math.PI * 1.3, 48)],
      satin: { width: 3, density: 0.4, pullComp: 0.2, underlay: ['center'], lean: 0,
        mode: 'border', split: { enabled: false, maxLength: 6, stagger: 0.7 } } }),
    newObject({ name: 's-column-taper', color: '#1f6feb', type: 'satin', twoRail: true,
      paths: [
        [{ x: -8, y: -30 }, { x: 6, y: -28 }, { x: 18, y: -26 }],
        // 3 mm at the narrow end widening to 8 mm — variable width that
        // stays inside the 10 mm satin limit. Drawn wider, the engine refuses
        // it and says to use a fill or turn on splitting, which is correct.
        [{ x: -8, y: -27 }, { x: 6, y: -22.5 }, { x: 18, y: -18 }],
      ],
      satin: { width: 3, density: 0.4, pullComp: 0.2, underlay: ['center'], lean: 0,
        mode: 'column', split: { enabled: false, maxLength: 6, stagger: 0.7 } } }),

    // A CONCAVE fill WITH A HOLE that must stay empty.
    newObject({ name: 's-fill-hole', color: '#16a34a', type: 'fill',
      paths: [
        [{ x: -16, y: -6 }, { x: 2, y: -6 }, { x: 2, y: 10 }, { x: -6, y: 4 },
          { x: -16, y: 10 }, { x: -16, y: -6 }],
        circle(-8, 0, 3),
      ] }),

    // SMALL DETAIL: a 1.2 mm column, near the narrow floor.
    newObject({ name: 's-small', color: '#16a34a', type: 'satin',
      paths: [[{ x: 8, y: -4 }, { x: 22, y: -4 }]],
      satin: { width: 1.2, density: 0.35, pullComp: 0.15, underlay: [], lean: 0,
        mode: 'border', split: { enabled: false, maxLength: 6, stagger: 0.7 } } }),

    // PATCH CORNERS, both treatments.
    newObject({ name: 's-patch', color: '#7c3aed', type: 'patch',
      paths: [rect(26, -30, 24, 16)],
      patch: { widthMm: 3, density: 0.35, overhangMm: 0.7, corner: 'fan' } }),

    // Program motifs and counted work.
    newObject({ name: 's-knots', color: '#d97706', type: 'program',
      paths: [[{ x: 30, y: -8 }, { x: 38, y: -8 }, { x: 46, y: -8 }]],
      program: { kind: 'frenchknot', sizeMm: 3, holeMm: 1.5, passes: 7, spacingMm: 6 } }),
    newObject({ name: 's-eyelet', color: '#d97706', type: 'program',
      paths: [circle(38, 2, 4)],
      program: { kind: 'eyelet', sizeMm: 7, holeMm: 2.5, passes: 10, spacingMm: 6 } }),
    newObject({ name: 's-cross', color: '#0891b2', type: 'fill',
      paths: [rect(-52, 8, 16, 12)],
      fill: { style: 'crossstitch', angle: 0, spacing: 0.4, length: 3, stagger: 0.5, crossPasses: 1,
        underlay: [], border: { enabled: false, width: 2, density: 0.4 } } }),
    newObject({ name: 's-stipple', color: '#0891b2', type: 'fill',
      paths: [rect(-32, 8, 16, 12)],
      fill: { style: 'stipple', angle: 0, spacing: 2.2, length: 2.5, stagger: 0.5, crossPasses: 1,
        underlay: [], border: { enabled: false, width: 2, density: 0.4 } } }),
    newObject({ name: 's-echo', color: '#0891b2', type: 'fill',
      paths: [rect(-12, 8, 16, 12)],
      fill: { style: 'echo', angle: 0, spacing: 1.6, length: 2.5, stagger: 0.5, crossPasses: 1,
        underlay: [], border: { enabled: false, width: 2, density: 0.4 } } }),
    newObject({ name: 's-motif', color: '#0891b2', type: 'fill',
      paths: [rect(8, 8, 16, 12)],
      fill: { style: 'motif', angle: 0, spacing: 4, length: 3, stagger: 0.5, crossPasses: 1,
        underlay: [], border: { enabled: false, width: 2, density: 0.4 } } }),

    // Freestanding lace and an appliqué with its machine stops.
    newObject({ name: 's-lace', color: '#db2777', type: 'lace',
      paths: [circle(34, 16, 11)],
      lace: { pattern: 'diamond', spacingMm: 2.5, angle: 0, passes: 3, borderPasses: 4 } }),
    newObject({ name: 's-applique', color: '#0f766e', type: 'applique',
      paths: [circle(-40, 28, 10)],
      applique: { tackWidth: 1.6, tackDensity: 0.5, borderWidth: 3, borderDensity: 0.4,
        borderPullComp: 0.2, border: true, borderStyle: 'satin' } }),
    // Manual stitches, and a construction line that must sew nothing.
    newObject({ name: 's-manual', color: '#0f766e', type: 'manual',
      paths: [[{ x: -14, y: 26 }, { x: -6, y: 30 }, { x: 2, y: 24 }, { x: 10, y: 30 }, { x: 18, y: 26 }]] }),
    newObject({ name: 's-none', color: '#64748b', type: 'none',
      paths: [[{ x: -52, y: 34 }, { x: 52, y: 34 }]] }),
  ],
})

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
  // The other machine formats, from the SAME plan — which is the only way
  // they can be compared against each other and against the intent.
  writeFileSync(`${OUT}${f.name}.exp`, writeExp(centered))
  // A fixed date, so two runs produce byte-identical files and "the file
  // changed" keeps meaning something.
  writeFileSync(`${OUT}${f.name}.jef`, writeJef(centered, new Date(Date.UTC(2026, 0, 1, 12, 0, 0))))

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
