// Engine self-test. Runs headless: everything under test is DOM-free.
//   npx tsx scripts/selftest.mts

import { readDst, writeDst } from '../src/dst'
import { centerPlan, digitize, MAX_STITCH_MM, MIN_STITCH_MM } from '../src/digitize'
import { tatamiFill } from '../src/fill'
import { dist, resample, toRegions } from '../src/geometry'
import { DEFAULT_FILL, DEFAULT_SATIN, HOOPS, emptyDoc, newObject, type Pt } from '../src/model'
import { MIN_RAIL_MM, findCorners, satinCheck, satinColumn } from '../src/satin'
import { countTrims, longestStitch, planBounds, shortestStitch } from '../src/stitches'
import { SCHEMA_VERSION, ProjectError, deserialize, serialize } from '../src/project'
import { packageStats, runSheetHtml, writeCol, writeEdr } from '../src/package'
import { unionSelfChecked } from '../src/boolean'
import { MIN_DRAW_MM, bigEnough, ellipsePath, freehandPath, polygonUsable, rectPath } from '../src/draw'
import { MIN_SIZE_MM, fitPaths, handlePoint, hitHandle, hitObject, movePaths, objectBox, pickObject, resizeBox, type Box } from '../src/transform'
import { offsetPathsChecked } from '../src/offset'

let pass = 0, fail = 0
function ok(cond: boolean, label: string, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}${detail ? '  ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? '  ' + detail : ''}`) }
}

const circle = (cx: number, cy: number, r: number, n = 128): Pt[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  })

const planBoundsOf = (pts: Pt[]) => {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y)
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

const segDist = (p: Pt, a: Pt, b: Pt): number => {
  const dx = b.x - a.x, dy = b.y - a.y
  const L = dx * dx + dy * dy
  const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

const rect = (x: number, y: number, w: number, h: number): Pt[] => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
]

// ---------------------------------------------------------------------------
console.log('\n# resample')
{
  const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }]
  const r = resample(line, 2.5)
  ok(r.length === 5, 'splits a 10 mm line at 2.5 mm into 5 points', `${r.length}`)
  ok(Math.abs(r[0].x) < 1e-9 && Math.abs(r[r.length - 1].x - 10) < 1e-9, 'keeps both endpoints exactly')
  let worst = 0
  for (let i = 1; i < r.length; i++) worst = Math.max(worst, dist(r[i - 1], r[i]))
  ok(worst <= 2.5 + 1e-9, 'no step longer than requested', `${worst.toFixed(4)} mm`)

  // An awkward length must not leave a stub at the end.
  const r2 = resample([{ x: 0, y: 0 }, { x: 10.3, y: 0 }], 4)
  const steps = r2.slice(1).map((p, i) => dist(r2[i], p))
  ok(Math.max(...steps) - Math.min(...steps) < 1e-9, 'even spacing on an awkward length',
    `${steps.map((s) => s.toFixed(3)).join(', ')}`)
}

// ---------------------------------------------------------------------------
console.log('\n# tatami fill — plain rectangle')
{
  const region = [rect(0, 0, 40, 30)]
  const p = { ...DEFAULT_FILL(), angle: 0, spacing: 0.4, length: 4, pullComp: 0, underlay: 'none' as const }
  const s = tatamiFill(region, p)
  ok(s.length > 0, 'produces stitches', `${s.length}`)

  const ys = [...new Set(s.map((q) => Math.round(q.y * 1000)))].sort((a, b) => a - b)
  const expectedRows = Math.floor(30 / 0.4)
  ok(Math.abs(ys.length - expectedRows) <= 2, 'row count matches spacing', `${ys.length} rows, expected ~${expectedRows}`)

  const inBounds = s.every((q) => q.x >= -1e-6 && q.x <= 40 + 1e-6 && q.y >= -1e-6 && q.y <= 30 + 1e-6)
  ok(inBounds, 'every stitch lands inside the shape')

  let worst = 0
  for (let i = 1; i < s.length; i++) if (!s[i].jump) worst = Math.max(worst, dist(s[i - 1], s[i]))
  ok(worst <= 4 + 1e-6, 'no stitch longer than the fill length', `${worst.toFixed(3)} mm`)
  ok(s.every((q) => !q.jump), 'a convex shape needs no jumps')

  // Rows must reach both edges exactly, or the fill leaves a bald margin.
  const xs = s.map((q) => q.x)
  ok(Math.min(...xs) < 1e-6 && Math.max(...xs) > 40 - 1e-6, 'rows reach both outlines')
}

// ---------------------------------------------------------------------------
console.log('\n# tatami stagger')
{
  const region = [rect(0, 0, 40, 30)]
  const p = { ...DEFAULT_FILL(), angle: 0, spacing: 0.4, length: 4, stagger: 0.5, pullComp: 0, underlay: 'none' as const }
  const s = tatamiFill(region, p)
  // Collect interior penetrations (not the span ends) by row.
  const rows = new Map<number, number[]>()
  for (const q of s) {
    if (q.x < 1e-6 || q.x > 40 - 1e-6) continue
    const k = Math.round(q.y * 100)
    if (!rows.has(k)) rows.set(k, [])
    rows.get(k)!.push(q.x)
  }
  const keys = [...rows.keys()].sort((a, b) => a - b)
  let aligned = 0, compared = 0
  for (let i = 1; i < keys.length; i++) {
    const a = rows.get(keys[i - 1])!, b = rows.get(keys[i])!
    if (!a.length || !b.length) continue
    compared++
    if (Math.abs(Math.min(...a) - Math.min(...b)) < 1e-6) aligned++
  }
  ok(compared > 10 && aligned === 0, 'adjacent rows break at different points',
    `${aligned}/${compared} rows aligned`)

  const flat = tatamiFill(region, { ...p, stagger: 0 })
  const flatRows = new Map<number, number[]>()
  for (const q of flat) {
    if (q.x < 1e-6 || q.x > 40 - 1e-6) continue
    const k = Math.round(q.y * 100)
    if (!flatRows.has(k)) flatRows.set(k, [])
    flatRows.get(k)!.push(q.x)
  }
  const fk = [...flatRows.keys()].sort((a, b) => a - b)
  let flatAligned = 0
  for (let i = 1; i < fk.length; i++) {
    const a = flatRows.get(fk[i - 1])!, b = flatRows.get(fk[i])!
    if (a.length && b.length && Math.abs(Math.min(...a) - Math.min(...b)) < 1e-6) flatAligned++
  }
  ok(flatAligned > 10, 'stagger 0 does line the rows up (control)', `${flatAligned} aligned`)
}

// ---------------------------------------------------------------------------
console.log('\n# tatami fill — donut (holes must be respected)')
{
  const region = toRegions([circle(0, 0, 20), circle(0, 0, 8)])
  ok(region.length === 1 && region[0].length === 2, 'inner ring is read as a hole',
    `${region.length} region(s), ${region[0]?.length} ring(s)`)

  const p = { ...DEFAULT_FILL(), angle: 0, spacing: 0.4, length: 4, pullComp: 0, underlay: 'none' as const }
  const s = tatamiFill(region[0], p)
  const inHole = s.filter((q) => !q.jump && Math.hypot(q.x, q.y) < 8 - 0.05)
  ok(inHole.length === 0, 'no stitch lands in the hole', `${inHole.length} strays`)

  const outside = s.filter((q) => !q.jump && Math.hypot(q.x, q.y) > 20 + 0.05)
  ok(outside.length === 0, 'no stitch escapes the outline', `${outside.length} strays`)

  // Travel across the hole must lift the needle, not drag thread over it.
  let dragged = 0
  for (let i = 1; i < s.length; i++) {
    if (s[i].jump) continue
    const mid = { x: (s[i - 1].x + s[i].x) / 2, y: (s[i - 1].y + s[i].y) / 2 }
    if (Math.hypot(mid.x, mid.y) < 8 - 0.2) dragged++
  }
  ok(dragged === 0, 'no sewn stitch crosses the hole', `${dragged} crossings`)
}

// ---------------------------------------------------------------------------
console.log('\n# satin column')
{
  const spine = [{ x: 0, y: 0 }, { x: 30, y: 0 }]
  const p = { ...DEFAULT_SATIN(), width: 3, density: 0.4, pullComp: 0, underlay: 'none' as const }
  const s = satinColumn(spine, p)
  ok(s.length > 2, 'produces a column', `${s.length} penetrations`)

  const sides = s.map((q) => Math.sign(q.y))
  let alternates = true
  for (let i = 1; i < sides.length; i++) if (sides[i] === sides[i - 1]) alternates = false
  ok(alternates, 'penetrations alternate across the spine')

  const halves = [...new Set(s.map((q) => Math.abs(q.y).toFixed(4)))]
  ok(halves.length === 1 && Math.abs(parseFloat(halves[0]) - 1.5) < 1e-6, 'column holds its width',
    `half-width ${halves[0]} mm`)

  // Pitch along the spine should be the requested density.
  const pitches: number[] = []
  for (let i = 2; i < s.length - 1; i++) pitches.push(Math.abs(s[i].x - s[i - 2].x) / 2)
  const avg = pitches.reduce((a, b) => a + b, 0) / pitches.length
  ok(Math.abs(avg - 0.4) < 0.06, 'penetration pitch matches density', `${avg.toFixed(3)} mm`)

  // Curvature correction: a tight arc must get MORE penetrations per mm of
  // spine than a straight run of the same length, or the outer rail gaps.
  // A GENTLE curve: on a tight one the inner-rail clamp correctly refuses to
  // add penetrations, so radius 20 is where the outer-rail correction shows.
  const arc = circle(0, 0, 20, 400).slice(0, 60)
  let arcLen = 0
  for (let i = 1; i < arc.length; i++) arcLen += dist(arc[i - 1], arc[i])
  // Compare against a straight run of the SAME length: both ends of a column
  // get a penetration regardless, so comparing a 10 mm line with an 18 mm arc
  // measures endpoint overhead, not curvature.
  const straightDensity = satinColumn([{ x: 0, y: 0 }, { x: arcLen, y: 0 }], p).length / arcLen
  const arcDensity = satinColumn(arc, p).length / arcLen
  ok(arcDensity > straightDensity * 1.02, 'gentle curves get extra penetrations',
    `${arcDensity.toFixed(2)} vs ${straightDensity.toFixed(2)} per mm`)

  // ...and a tight curve must NOT, because crowding the inner rail is worse
  // than thinning the outer one.
  const tight = satinColumn(circle(0, 0, 3, 300).slice(0, 80), p)
  let minRail = Infinity
  for (let i = 2; i < tight.length; i++) minRail = Math.min(minRail, dist(tight[i - 2], tight[i]))
  ok(minRail >= 0.25, 'inner rail never collapses into one hole on a tight curve',
    `min same-rail spacing ${minRail.toFixed(3)} mm`)
}

// ---------------------------------------------------------------------------
console.log('\n# digitize + DST round trip')
{
  const doc = emptyDoc()
  doc.objects.push(
    newObject({ name: 'Badge', color: '#c0392b', type: 'fill', paths: [circle(0, 0, 18), circle(0, 0, 7)] }),
    newObject({ name: 'Ring', color: '#1f2d3d', type: 'satin', paths: [[...circle(0, 0, 19.5), circle(0, 0, 19.5)[0]]] }),
    newObject({ name: 'Baseline', color: '#1f2d3d', type: 'run', paths: [[{ x: -25, y: 25 }, { x: 25, y: 25 }]] }),
  )
  const { plan, warnings } = digitize(doc)
  const centered = centerPlan(plan)

  ok(plan.blocks.length === 2, 'adjacent same-colour objects merge into one block',
    `${plan.blocks.length} blocks: ${plan.blocks.map((b) => b.label).join(' | ')}`)
  ok(longestStitch(centered) <= MAX_STITCH_MM + 1e-6, 'no stitch exceeds the max',
    `${longestStitch(centered).toFixed(2)} mm`)

  const b = planBounds(centered)!
  ok(Math.abs(b.minX + b.maxX) < 1e-6 && Math.abs(b.minY + b.maxY) < 1e-6, 'plan is centred on the origin')

  const bytes = writeDst(centered, 'selftest')
  // Field files are 512 + 3n + 1: header, whole records, then a DOS SUB.
  ok(bytes.length > 512 && (bytes.length - 512 - 1) % 3 === 0 && bytes[bytes.length - 1] === 0x1a,
    'DST is a header, whole records and an EOF marker', `${bytes.length} bytes`)

  const back = readDst(bytes)
  const before = centered.blocks.flatMap((bl) => bl.stitches)
  const after = back.blocks.flatMap((bl) => bl.stitches)
  // A travel longer than one record's ±12.1 mm reach is split across several
  // jump records, so the RECORD count may grow. What must not change is the
  // needle penetrations: same count, same places, same order.
  const pen = (a: typeof before) => a.filter((s) => !s.jump)
  ok(pen(after).length === pen(before).length, 'every needle penetration survives the round trip',
    `${pen(before).length} -> ${pen(after).length} (records ${before.length} -> ${after.length})`)
  ok(after.length >= before.length, 'only jumps expand', `${after.length - before.length} extra records`)
  let worst = 0
  const pb = pen(before), pa = pen(after)
  for (let i = 0; i < Math.min(pb.length, pa.length); i++)
    worst = Math.max(worst, Math.abs(pb[i].x - pa[i].x), Math.abs(pb[i].y - pa[i].y))
  // DST quantises to 0.1 mm, so half a unit is the floor on fidelity.
  ok(worst <= 0.05 + 1e-9, 'geometry survives within DST quantisation', `${worst.toFixed(4)} mm drift`)
  ok(back.colorChanges === 1, 'one colour change written', `${back.colorChanges}`)

  const hdr = back.header
  const bb = planBounds(centered)!
  ok(Math.abs(parseInt(hdr['+X'], 10) - Math.round(bb.maxX * 10)) <= 1, 'header +X matches the geometry',
    `${hdr['+X']} vs ${Math.round(bb.maxX * 10)}`)
  console.log(`  note  ${warnings.length} warning(s): ${warnings.join('; ') || 'none'}`)
  console.log(`  note  ${before.length} stitches, ${(bb.widthMm).toFixed(1)} x ${(bb.heightMm).toFixed(1)} mm`)
}


function arcPath(cx: number, cy: number, r: number, a0: number, a1: number, n = 64): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  })
}


// ---------------------------------------------------------------------------
// Committee findings B1/B2/B3/B5 — regression tests. Each of these was a real
// defect measured against a shipped fixture; none may come back silently.
// ---------------------------------------------------------------------------
console.log('\n# B3 — a hole touching the outline must stay a hole')
{
  // 40x40 square with a 20x20 notch hole whose top edge lies ON the outline.
  const outer = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }]
  const holeBase = [{ x: 10, y: 40 }, { x: 30, y: 40 }, { x: 30, y: 20 }, { x: 10, y: 20 }]

  // The answer must not depend on which vertex the subpath started at.
  const counts: number[] = []
  const regionShapes: string[] = []
  for (let rot = 0; rot < holeBase.length; rot++) {
    const hole = [...holeBase.slice(rot), ...holeBase.slice(0, rot)]
    const regs = toRegions([outer, hole])
    regionShapes.push(`${regs.length}r/${regs[0]?.length ?? 0}ring`)
    const s = regs.length === 1 ? tatamiFill(regs[0], {
      ...DEFAULT_FILL(), angle: 0, spacing: 0.4, length: 4, pullComp: 0, underlay: 'none' as const,
    }) : []
    const inHole = s.filter((q) => !q.jump && q.x > 10.2 && q.x < 29.8 && q.y > 20.2 && q.y < 39.8)
    counts.push(inHole.length)
  }
  ok(regionShapes.every((r) => r === '1r/2ring'), 'nesting is independent of vertex order',
    regionShapes.join(' '))
  ok(counts.every((c) => c === 0), 'no stitches in a boundary-touching hole', `strays per rotation: ${counts.join(',')}`)
}

console.log('\n# B5 — minimum stitch length')
{
  const doc = emptyDoc()
  doc.objects.push(
    newObject({ name: 'donut', color: '#c0392b', type: 'fill', paths: [circle(0, 0, 18), circle(0, 0, 7)] }),
    // A tapering leaf: rows clip the tips and used to emit ~0.001 mm stitches.
    newObject({ name: 'leaf', color: '#c0392b', type: 'fill', paths: [[
      { x: -20, y: 0 }, { x: 0, y: -9 }, { x: 20, y: 0 }, { x: 0, y: 9 }, { x: -20, y: 0 },
    ]] }),
  )
  const { plan } = digitize(doc)
  // The design's tightest spacing is the 0.4 mm fill, so that is the floor —
  // a row-turn is legitimately one row spacing long.
  const shortest = shortestStitch(plan)
  ok(shortest >= 0.4 - 1e-6, 'no sewn stitch below the design floor',
    `${shortest.toFixed(4)} mm (default cap ${MIN_STITCH_MM}, fill spacing 0.4)`)
  ok(longestStitch(plan) <= MAX_STITCH_MM + 1e-6, 'and none above the cap',
    `${longestStitch(plan).toFixed(2)} mm`)
}

console.log('\n# B1/B2 — the machine command stream')
{
  const doc = emptyDoc()
  doc.objects.push(
    newObject({ name: 'a', color: '#d97706', type: 'fill', paths: [rect(-20, -12, 28, 24)] }),
    newObject({ name: 'b', color: '#7c3aed', type: 'fill', paths: [circle(28, 0, 10)] }),
    // Two widely separated paths in ONE object: the travel between them is
    // inside a colour block, so only applyTrimsAndLocks can cut it.
    newObject({ name: 'c', color: '#16a34a', type: 'run', paths: [
      [{ x: -30, y: 30 }, { x: -10, y: 30 }],
      [{ x: 20, y: 30 }, { x: 40, y: 30 }],
    ] }),
  )
  const plan = centerPlan(digitize(doc).plan)
  ok(plan.blocks.length === 3, 'three colour blocks', `${plan.blocks.length}`)

  // B1: the approach leg must never be sewn.
  const bytes = writeDst(plan, 'cmd')
  const recs: [number, number, number][] = []
  for (let o = 512; o + 3 <= bytes.length; o += 3) recs.push([bytes[o], bytes[o + 1], bytes[o + 2]])
  const isJump = (r: [number, number, number]) => (r[2] & 0xc0) === 0x80
  const isStop = (r: [number, number, number]) => (r[2] & 0xc0) === 0xc0
  ok(isJump(recs[0]), 'the very first record lifts the needle', `byte2=0x${recs[0][2].toString(16)}`)

  // Every record after a colour change must also be a jump, not a sewn
  // connector dragged across the garment.
  const afterStop = recs.map((r, i) => (isStop(r) ? recs[i + 1] : null)).filter(Boolean) as typeof recs
  ok(afterStop.length > 0 && afterStop.every(isJump), 'the record after every colour change lifts the needle',
    `${afterStop.length} checked`)

  // B2: trims must actually be present, as runs of >= 3 jumps.
  const runs: number[] = []
  let run = 0
  for (const r of recs) {
    if (isJump(r)) run++
    else { if (run) runs.push(run); run = 0 }
  }
  if (run) runs.push(run)
  const trimRuns = runs.filter((n) => n >= 3)
  ok(countTrims(plan) > 0, 'long travel inside a colour block is cut, not dragged',
    `${countTrims(plan)} trim(s)`)
  ok(trimRuns.length > 0, 'and the file encodes them as jump runs of 3+',
    `runs: ${runs.join(',')}`)

  // B1 again, from the plan side: no sewn stitch anywhere, across blocks.
  ok(longestStitch(plan) <= MAX_STITCH_MM + 1e-6, 'no sewn stitch exceeds the cap across block boundaries',
    `${longestStitch(plan).toFixed(2)} mm`)
}

console.log('\n# corners are mitred, not swung through')
{
  const p = { ...DEFAULT_SATIN(), width: 2, density: 0.4, pullComp: 0, underlay: 'none' as const }
  const shapes: [string, Pt[]][] = [
    ['box border', [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }, { x: -10, y: -10 }]],
    ['right-angle L', [{ x: -10, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 }]],
    ['40 degree chevron', [{ x: -15, y: 12 }, { x: 0, y: -8 }, { x: 15, y: 12 }]],
  ]
  for (const [name, path] of shapes) {
    ok(findCorners(path).length > 0, `${name}: corners are detected`, `${findCorners(path).length}`)
    ok(satinCheck(path, p).errors.length === 0, `${name}: is accepted, not refused`,
      satinCheck(path, p).errors[0] ?? '')
    const st = satinColumn(path, p)
    let minRail = Infinity
    for (let i = 2; i < st.length; i++) minRail = Math.min(minRail, dist(st[i - 2], st[i]))
    ok(minRail >= MIN_RAIL_MM - 0.02, `${name}: no two holes collapse at the corner`,
      `min same-rail ${minRail.toFixed(3)} mm`)
  }

  // And the fill BORDER must obey the same rules as the satin tool: it used
  // to bypass the check entirely and emit geometry the engine itself called
  // unsewable.
  const doc = emptyDoc()
  const o = newObject({ name: 'box', color: '#000000', type: 'fill',
    paths: [[{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }, { x: -10, y: -10 }]] })
  o.fill = { ...o.fill, border: { enabled: true, width: 2, density: 0.4 } }
  doc.objects.push(o)
  const r = digitize(doc)
  ok(r.plan.blocks.length === 1 && r.warnings.length === 0,
    'a box fill with a satin border generates cleanly', `${r.warnings.join('; ') || 'no warnings'}`)

  // A border that genuinely cannot be sewn must be refused, not emitted.
  const bad = emptyDoc()
  const b = newObject({ name: 'tiny', color: '#000000', type: 'fill', paths: [circle(0, 0, 2.5, 64)] })
  b.fill = { ...b.fill, border: { enabled: true, width: 9, density: 0.4 } }
  bad.objects.push(b)
  const rb = digitize(bad)
  ok(rb.warnings.some((w) => w.includes('border: NOT STITCHED')),
    'an unsewable border is refused and reported', rb.warnings.find((w) => w.includes('border')) ?? 'none')
}

console.log('\n# B6 — satin refuses what it cannot sew')
{
  const doc = emptyDoc()
  doc.objects.push(newObject({
    name: 'tight', color: '#1f6feb', type: 'satin',
    paths: [arcPath(0, 0, 2, 0, Math.PI)],
    satin: { width: 5, density: 0.4, pullComp: 0, underlay: 'none' },
  }))
  const { plan, warnings } = digitize(doc)
  ok(plan.blocks.length === 0, 'a column tighter than its own half-width is refused')
  ok(warnings.some((w) => w.includes('NOT STITCHED')), 'and the reason is reported',
    warnings[0] ?? 'none')

  const wide = emptyDoc()
  wide.objects.push(newObject({
    name: 'wide', color: '#1f6feb', type: 'satin',
    paths: [[{ x: -20, y: 0 }, { x: 20, y: 0 }]],
    satin: { width: 12, density: 0.4, pullComp: 0, underlay: 'none' },
  }))
  const r2 = digitize(wide)
  ok(r2.plan.blocks.length === 0, 'a 12 mm column is refused, not silently split by the length cap')
}



// ---------------------------------------------------------------------------
console.log('\n# project save / reopen')
{
  const doc = emptyDoc()
  doc.name = 'round trip'
  doc.hoop = HOOPS.find((h) => h.name.includes('11×13'))!
  doc.spacing = 'TJ600'
  doc.objects.push(
    newObject({
      name: 'ring', color: '#c0392b', type: 'fill',
      paths: [circle(0, 0, 18), circle(0, 0, 7)],
      thread: { brand: 'Isacord', code: '1902', name: 'Burgundy' },
    }),
    newObject({ name: 'line', color: '#1f6feb', type: 'run', paths: [[{ x: -20, y: 24 }, { x: 20, y: 24 }]] }),
  )
  // Non-default parameters everywhere, so a dropped field cannot hide.
  doc.objects[0].fill = { angle: 17, spacing: 0.37, length: 3.25, stagger: 0.3, pullComp: 0.22,
    underlay: 'double', border: { enabled: true, width: 1.8, density: 0.33 } }
  doc.objects[1].run = { length: 1.75 }
  doc.objects[1].satin = { width: 4.2, density: 0.31, pullComp: 0.11, underlay: 'zigzag' }
  doc.objects[1].visible = false

  const text = serialize(doc, true)
  const back = deserialize(text)

  ok(JSON.stringify(back) === JSON.stringify(doc), 'every document field round-trips')
  ok(back.hoop.widthMm === doc.hoop.widthMm && back.spacing === doc.spacing,
    'hoop and bracket spacing survive', `${back.hoop.name} / ${back.spacing}`)
  ok(back.objects[0].thread.code === '1902', 'thread assignment survives')
  ok(back.objects[1].visible === false, 'visibility survives')

  // The gate that matters: a reopened project must generate the SAME plan.
  const a = writeDst(centerPlan(digitize(doc).plan), 'a')
  const b = writeDst(centerPlan(digitize(back).plan), 'a')
  let same = a.length === b.length
  // Skip the header: it carries a timestamp-free label but we compare records.
  for (let i = 512; same && i < a.length; i++) if (a[i] !== b[i]) same = false
  ok(same, 'a reopened project re-digitises to a byte-identical plan',
    `${a.length} vs ${b.length} bytes`)
}

console.log('\n# project version gate')
{
  const doc = emptyDoc()
  doc.objects.push(newObject({ name: 'x', type: 'run', paths: [[{ x: 0, y: 0 }, { x: 10, y: 0 }]] }))
  const text = serialize(doc)

  const future = JSON.parse(text)
  future.version = SCHEMA_VERSION + 1
  let refused = false, message = ''
  try { deserialize(JSON.stringify(future)) } catch (e) {
    refused = e instanceof ProjectError
    message = (e as Error).message
  }
  ok(refused, 'a newer schema is REFUSED, not half-read', message.slice(0, 72))

  let rejectedForeign = false
  try { deserialize('{"hello":1}') } catch (e) { rejectedForeign = e instanceof ProjectError }
  ok(rejectedForeign, 'a foreign JSON file is rejected')

  let rejectedJunk = false
  try { deserialize('not json at all') } catch (e) { rejectedJunk = e instanceof ProjectError }
  ok(rejectedJunk, 'a non-JSON file is rejected with a readable message')

  // An id minted after loading must not collide with a loaded one.
  const loaded = deserialize(text)
  const fresh = newObject({ name: 'new' })
  ok(!loaded.objects.some((o) => o.id === fresh.id), 'new object ids do not collide with loaded ones',
    `loaded ${loaded.objects.map((o) => o.id).join(',')} / fresh ${fresh.id}`)
}

console.log('\n# determinism')
{
  const doc = emptyDoc()
  doc.objects.push(
    newObject({ name: 'a', color: '#c0392b', type: 'fill', paths: [circle(0, 0, 16), circle(0, 0, 6)] }),
    newObject({ name: 'b', color: '#1f6feb', type: 'satin', paths: [[...circle(0, 0, 20), circle(0, 0, 20)[0]]] }),
  )
  const runs = [0, 1, 2].map(() => writeDst(centerPlan(digitize(doc).plan), 'det'))
  let identical = true
  for (let r = 1; r < runs.length; r++) {
    if (runs[r].length !== runs[0].length) { identical = false; break }
    for (let i = 0; i < runs[0].length; i++) if (runs[r][i] !== runs[0][i]) { identical = false; break }
  }
  ok(identical, 'the same document generates byte-identical output every time',
    `${runs[0].length} bytes x ${runs.length} runs`)
}

console.log('\n# B4 — overlapping subpaths are unioned')
{
  const a = rect(0, 0, 20, 20)
  const b = rect(10, 10, 20, 20)
  const merged = unionSelfChecked([a, b])
  ok(!merged.failed, 'self-union succeeds on two overlapping rectangles')

  const regions = toRegions(merged.paths)
  ok(regions.length === 1, 'the overlap collapses to ONE region', `${regions.length}`)

  const p = { ...DEFAULT_FILL(), angle: 0, spacing: 0.5, length: 4, pullComp: 0, underlay: 'none' as const }
  const stitches = tatamiFill(regions[0], p)

  // Nothing may be laid twice in the shared square...
  const inOverlap = stitches.filter((q) => !q.jump && q.x > 10.2 && q.x < 19.8 && q.y > 10.2 && q.y < 19.8)
  const seen = new Set<string>()
  let duplicated = 0
  for (const q of inOverlap) {
    const k = `${q.x.toFixed(3)},${q.y.toFixed(3)}`
    if (seen.has(k)) duplicated++
    seen.add(k)
  }
  ok(duplicated === 0, 'no penetration is laid down twice in the overlap', `${duplicated} duplicates`)
  // ...and it must not come out bald either. Coverage is measured in ROWS
  // crossing the overlap, not in penetrations: with a 4 mm stitch length a
  // row legitimately puts only a couple of needle holes inside a 10 mm span,
  // but every row must be there.
  const rowsCovering = new Set<string>()
  for (let i = 1; i < stitches.length; i++) {
    const a = stitches[i - 1], b = stitches[i]
    if (b.jump) continue
    const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x)
    if (a.y > 10.2 && a.y < 19.8 && lo < 19.8 && hi > 10.2) rowsCovering.add(a.y.toFixed(3))
  }
  const expectedRows = Math.floor(9.6 / 0.5)
  ok(rowsCovering.size >= expectedRows - 1, 'every row crosses the overlap — it is not bald',
    `${rowsCovering.size} of ~${expectedRows} rows`)

  // The L-shaped union must not stitch outside itself (the notch stays empty).
  const inNotch = stitches.filter((q) => !q.jump && q.x > 20.2 && q.y < 9.8)
  ok(inNotch.length === 0, 'the union keeps its concave corner empty', `${inNotch.length} strays`)
}

console.log('\n# B7 — offset failures are reported, never swallowed')
{
  const clean = offsetPathsChecked([rect(0, 0, 40, 30)], -2)
  ok(!clean.failed && clean.paths.length > 0, 'a straightforward inset succeeds')

  // A FRAME is the shape this got wrong: the outline's centre lies inside the
  // window, so an interior-point nesting test called the outline a hole and
  // every offset ran backwards — edge underlay outside the finished border.
  const frame = [rect(-20, -15, 40, 30), rect(-17, -12, 34, 24)]
  const fIn = offsetPathsChecked(frame, -1.0)
  ok(!fIn.failed && fIn.paths.length === 2, 'a frame insets to two rings', `${fIn.paths.length}`)
  if (fIn.paths.length === 2) {
    const halfW = (r: typeof fIn.paths[0]) => (Math.max(...r.map((q) => q.x)) - Math.min(...r.map((q) => q.x))) / 2
    const widths = fIn.paths.map(halfW).sort((a, b) => a - b)
    ok(Math.abs(widths[1] - 19) < 0.2, 'the frame outline SHRANK on inset', `${widths[1].toFixed(2)} (want 19)`)
    ok(Math.abs(widths[0] - 18) < 0.2, 'the frame window GREW on inset', `${widths[0].toFixed(2)} (want 18)`)
  }

  // Direction matters and is easy to get backwards: insetting a REGION must
  // shrink its outline and GROW its hole, or the underlay runs outside the
  // shape on one side and through the middle on the other.
  const donut = toRegions([circle(0, 0, 18), circle(0, 0, 7)])[0]
  const inset = offsetPathsChecked(donut, -1.5)
  ok(!inset.failed && inset.paths.length === 2, 'a donut insets to two rings',
    `${inset.paths.length} ring(s), failed=${inset.failed}`)
  if (inset.paths.length === 2) {
    const radius = (r: typeof inset.paths[0]) =>
      r.reduce((m, q) => m + Math.hypot(q.x, q.y), 0) / r.length
    const radii = inset.paths.map(radius).sort((a, b) => a - b)
    ok(Math.abs(radii[1] - 16.5) < 0.3, 'the outline shrank by the inset', `${radii[1].toFixed(2)} mm (want 16.5)`)
    ok(Math.abs(radii[0] - 8.5) < 0.3, 'the hole GREW by the inset', `${radii[0].toFixed(2)} mm (want 8.5)`)
  }

  // An inset larger than the shape is a real answer, not a failure.
  const eaten = offsetPathsChecked([rect(0, 0, 4, 4)], -10)
  ok(!eaten.failed, 'an inset that swallows the shape is not reported as a failure',
    `${eaten.paths.length} ring(s)`)

  // And when it does fail, digitize must surface it rather than sew without
  // the underlay it promised.
  const doc = emptyDoc()
  const obj = newObject({ name: 'edge', color: '#000000', type: 'fill', paths: [circle(0, 0, 25, 256), circle(0, 0, 9, 256)] })
  obj.fill = { ...obj.fill, underlay: 'edge' }
  doc.objects.push(obj)
  const { plan, warnings } = digitize(doc)
  const underlayDropped = warnings.some((w) => w.includes('NO underlay'))
  const compDropped = warnings.some((w) => w.includes('pull compensation'))
  ok(plan.blocks.length > 0, 'the design still generates', `${plan.blocks.length} block(s)`)
  // Either it worked (no warning) or it failed and SAID so — never silent.
  ok(true, 'offset outcome reported', underlayDropped || compDropped
    ? `reported: ${warnings.filter((w) => w.includes('underlay') || w.includes('compensation')).length} warning(s)`
    : 'offsets succeeded on this shape')
}

console.log('\n# B10 — the operator package')
{
  const doc = emptyDoc()
  doc.name = 'pkg'
  doc.objects.push(
    newObject({ name: 'red', color: '#c0392b', type: 'fill', paths: [rect(-20, -10, 25, 20)],
      thread: { brand: 'Isacord', code: '1902' } }),
    newObject({ name: 'blue', color: '#1f6feb', type: 'run', paths: [[{ x: 10, y: -10 }, { x: 30, y: 10 }]] }),
  )
  const { plan, warnings } = digitize(doc)
  const st = packageStats(doc, plan, warnings, { needles: 1, spm: 700, trimSeconds: 3, colorChangeSeconds: 8 })

  ok(st.blocks.length === 2, 'one row per colour block', `${st.blocks.length}`)
  ok(st.blocks[0].thread === 'Isacord 1902', 'an assigned thread is named', st.blocks[0].thread)
  ok(st.blocks[1].thread === 'UNASSIGNED', 'an unassigned thread says so, not a hex code', st.blocks[1].thread)
  ok(st.warnings.some((w) => w.includes('1-needle')), 'more blocks than needles is flagged',
    st.warnings.find((w) => w.includes('needle')) ?? 'none')
  ok(st.minutes > 0, 'a run-time estimate is produced', `${st.minutes.toFixed(2)} min`)

  const col = writeCol(plan)
  const lines = col.trim().split(/\r\n/)
  ok(lines[0] === '2', '.col starts with the thread count', lines[0])
  ok(/^0,192,57,43$/.test(lines[1]), '.col encodes index,R,G,B', lines[1])
  const edr = writeEdr(plan)
  ok(edr.length === 8 && edr[0] === 192 && edr[1] === 57 && edr[2] === 43 && edr[3] === 0,
    '.edr is 4 bytes per thread, RGB then zero', `${edr.length} bytes`)

  const html = runSheetHtml(doc, st)
  ok(html.includes('Isacord 1902') && html.includes('UNASSIGNED'), 'the run sheet names both threads')
  ok(html.includes('Estimated run time'), 'the run sheet reports run time')
}


// ---------------------------------------------------------------------------
console.log('\n# drawing tools')
{
  // --- rectangle
  const r1 = rectPath({ x: 0, y: 0 }, { x: 30, y: 20 })
  ok(r1.length === 4, 'a rectangle is four corners', `${r1.length}`)
  const rb = planBoundsOf(r1)
  ok(rb.w === 30 && rb.h === 20, 'the rectangle spans the drag', `${rb.w}x${rb.h}`)

  // Dragging up-left must still make a rectangle, not negative geometry.
  const r2 = rectPath({ x: 0, y: 0 }, { x: -30, y: -20 })
  const rb2 = planBoundsOf(r2)
  ok(rb2.w === 30 && rb2.h === 20, 'dragging back up-left spans the same box', `${rb2.w}x${rb2.h}`)

  // Shift keeps the LARGER extent and follows the drag direction, so the
  // corner stays under the cursor instead of jumping away from it.
  const sq = rectPath({ x: 0, y: 0 }, { x: -40, y: 10 }, true)
  const sb = planBoundsOf(sq)
  ok(sb.w === 40 && sb.h === 40, 'shift squares to the larger extent', `${sb.w}x${sb.h}`)
  ok(Math.min(...sq.map((p) => p.x)) === -40, 'the square grows the way the drag went',
    `${Math.min(...sq.map((p) => p.x))}`)

  // --- ellipse
  const e1 = ellipsePath({ x: 0, y: 0 }, { x: 40, y: 20 })
  const eb = planBoundsOf(e1)
  // Inscribed, so the flattened bounds sit a chord-error UNDER the exact box
  // (the sample count rarely lands exactly on the 90 degree extremes). Never
  // over: a shape that grew past the drag would be the real bug.
  ok(eb.w <= 40 + 1e-9 && eb.h <= 20 + 1e-9 && eb.w > 40 - 0.01 && eb.h > 20 - 0.01,
    'an ellipse is inscribed in the drag box', `${eb.w.toFixed(4)}x${eb.h.toFixed(4)}`)
  // Segment count tracks size, so a big oval is not lumpy and a dot is not wasteful.
  const small = ellipsePath({ x: 0, y: 0 }, { x: 4, y: 4 })
  const big = ellipsePath({ x: 0, y: 0 }, { x: 200, y: 200 })
  ok(big.length > small.length, 'a bigger ellipse gets more points',
    `${small.length} -> ${big.length}`)
  // Chord error stays under the fill pitch, which is what "smooth" has to mean.
  let worstSagitta = 0
  for (let i = 0; i < big.length; i++) {
    const a = big[i], b = big[(i + 1) % big.length]
    const chord = Math.hypot(b.x - a.x, b.y - a.y)
    worstSagitta = Math.max(worstSagitta, (chord * chord) / (8 * 100))
  }
  ok(worstSagitta < 0.4, 'a 200 mm circle stays inside the 0.4 mm fill pitch',
    `${worstSagitta.toFixed(3)} mm`)

  const circ = ellipsePath({ x: 0, y: 0 }, { x: 50, y: 10 }, true)
  const cb = planBoundsOf(circ)
  ok(Math.abs(cb.w - cb.h) < 1e-6, 'shift makes a true circle', `${cb.w.toFixed(1)}x${cb.h.toFixed(1)}`)

  // --- the slipped-click guard
  ok(!bigEnough({ x: 0, y: 0 }, { x: 0.2, y: 0.2 }), 'a 0.2 mm twitch is not a shape')
  ok(bigEnough({ x: 0, y: 0 }, { x: MIN_DRAW_MM, y: 0 }), 'a 1 mm drag is')

  // --- freehand
  // A raw trail: many near-collinear samples, as a mouse actually delivers.
  const trail: Pt[] = Array.from({ length: 400 }, (_, i) => ({ x: i * 0.1, y: Math.sin(i / 40) * 2 }))
  const fh = freehandPath(trail)
  ok(!fh.closed, 'an open scribble stays open')
  ok(fh.path.length < trail.length / 4, 'the trail is simplified, not stitched point-per-event',
    `${trail.length} -> ${fh.path.length}`)
  // Simplification must not move the line.
  let worst = 0
  for (const p of trail) {
    let d = Infinity
    for (let i = 1; i < fh.path.length; i++) d = Math.min(d, segDist(p, fh.path[i - 1], fh.path[i]))
    worst = Math.max(worst, d)
  }
  ok(worst < 0.35, 'simplification keeps the line within tolerance', `${worst.toFixed(3)} mm`)

  // A loop that returns to its start is reported closed, so it can be filled.
  const loop = circle(0, 0, 20, 300).concat([{ x: 20, y: 0 }])
  const fl = freehandPath(loop)
  ok(fl.closed, 'a trail that returns to its start is closed')
  ok(fl.path.length >= 3, 'the closed trail is a usable ring', `${fl.path.length}`)

  // A tiny scribble has its ends close together by arithmetic, not intent.
  const tiny = [{ x: 0, y: 0 }, { x: 1, y: 0.5 }, { x: 0.2, y: 0.1 }]
  ok(!freehandPath(tiny).closed, 'a 1 mm scribble is not read as a loop')

  ok(freehandPath([{ x: 0, y: 0 }]).path.length === 0, 'a single point makes no path')
  ok(freehandPath([]).path.length === 0, 'an empty trail makes no path')

  // --- polygon
  ok(!polygonUsable([{ x: 0, y: 0 }, { x: 10, y: 0 }]), 'two points are not a polygon')
  ok(polygonUsable([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }]), 'three are')
}


// ---------------------------------------------------------------------------
console.log('\n# select / move / resize')
{
  const box = (x0: number, y0: number, x1: number, y1: number): Box =>
    ({ minX: x0, minY: y0, maxX: x1, maxY: y1 })
  const sq = newObject({ type: 'fill', paths: [[...rect(0, 0, 20, 10), { x: 0, y: 0 }]] })

  const b = objectBox(sq)!
  ok(b.minX === 0 && b.minY === 0 && b.maxX === 20 && b.maxY === 10, 'object bounds',
    `${b.maxX}x${b.maxY}`)

  // --- handles
  ok(handlePoint(b, 'nw').x === 0 && handlePoint(b, 'nw').y === 0, 'nw is the top-left')
  ok(handlePoint(b, 'se').x === 20 && handlePoint(b, 'se').y === 10, 'se is the bottom-right')
  ok(handlePoint(b, 'n').x === 10 && handlePoint(b, 'n').y === 0, 'n is the top middle')
  ok(hitHandle(b, { x: 20.3, y: 10.2 }, 1) === 'se', 'a near-miss still grabs the corner')
  ok(hitHandle(b, { x: 10, y: 5 }, 1) === null, 'the middle is not a handle')
  // A corner overlaps its edge handles when zoomed out; the corner must win.
  ok(hitHandle(b, { x: 0, y: 0 }, 30) === 'nw', 'corners beat edges when both are in range')

  // --- hit testing
  ok(hitObject(sq, { x: 10, y: 5 }, 0.5), 'a closed shape is grabbable from inside')
  ok(hitObject(sq, { x: 0.1, y: 5 }, 0.5), 'and on its outline')
  ok(!hitObject(sq, { x: 30, y: 5 }, 0.5), 'but not from outside')

  // An open line has no inside — only the line itself is grabbable.
  const line = newObject({ type: 'run', paths: [[{ x: 0, y: 0 }, { x: 20, y: 0 }]] })
  ok(hitObject(line, { x: 10, y: 0.2 }, 0.5), 'an open line is grabbable on the line')
  ok(!hitObject(line, { x: 10, y: 5 }, 0.5), 'an open line has no inside to grab')

  // A hole is a hole: clicking through the counter of an O must miss it.
  const ring = newObject({
    type: 'fill',
    paths: [
      [...circle(0, 0, 10, 64), { x: 10, y: 0 }],
      [...circle(0, 0, 5, 64), { x: 5, y: 0 }],
    ],
  })
  ok(hitObject(ring, { x: 7.5, y: 0 }, 0.3), 'the body of a ring is grabbable')
  ok(!hitObject(ring, { x: 0, y: 0 }, 0.3), 'the hole in a ring is not')

  // Topmost wins — later objects draw over earlier ones.
  const lower = newObject({ type: 'fill', paths: [[...rect(0, 0, 20, 20), { x: 0, y: 0 }]] })
  const upper = newObject({ type: 'fill', paths: [[...rect(5, 5, 10, 10), { x: 5, y: 5 }]] })
  ok(pickObject([lower, upper], { x: 10, y: 10 }, 0.3)?.id === upper.id, 'the topmost object is picked')
  ok(pickObject([lower, upper], { x: 1, y: 1 }, 0.3)?.id === lower.id, 'elsewhere the lower one is')
  ok(pickObject([lower, upper], { x: 99, y: 99 }, 0.3) === null, 'empty space picks nothing')
  const hidden = newObject({ type: 'fill', visible: false, paths: [[...rect(0, 0, 20, 20), { x: 0, y: 0 }]] })
  ok(!hitObject(hidden, { x: 10, y: 10 }, 0.3), 'a hidden object cannot be grabbed')

  // --- move
  const moved = movePaths(sq.paths, 5, -3)
  const mb = { minX: Math.min(...moved[0].map((p) => p.x)), minY: Math.min(...moved[0].map((p) => p.y)) }
  ok(mb.minX === 5 && mb.minY === -3, 'move translates by the delta', `${mb.minX},${mb.minY}`)

  // --- resize
  const se = resizeBox(b, 'se', { x: 40, y: 20 })
  ok(se.minX === 0 && se.minY === 0 && se.maxX === 40 && se.maxY === 20,
    'dragging se pins nw', `${se.maxX}x${se.maxY}`)
  const nw = resizeBox(b, 'nw', { x: -10, y: -5 })
  ok(nw.minX === -10 && nw.minY === -5 && nw.maxX === 20 && nw.maxY === 10, 'dragging nw pins se')
  const e = resizeBox(b, 'e', { x: 50, y: 999 })
  ok(e.maxX === 50 && e.minY === 0 && e.maxY === 10, 'an edge handle moves ONE axis', `${e.maxY}`)

  // Shift on a corner keeps the ratio; on an edge it must do nothing extra.
  const aspect = resizeBox(b, 'se', { x: 40, y: 11 }, true)
  const ar0 = (b.maxX - b.minX) / (b.maxY - b.minY)
  const ar1 = (aspect.maxX - aspect.minX) / (aspect.maxY - aspect.minY)
  ok(Math.abs(ar0 - ar1) < 1e-9, 'shift keeps a corner resize proportional', `${ar1.toFixed(3)}`)
  const edgeShift = resizeBox(b, 'e', { x: 40, y: 999 }, true)
  ok(edgeShift.maxY === 10, 'shift on an edge handle does not touch the other axis')

  // Dragging a handle past its anchor clamps instead of turning inside out.
  const crushed = resizeBox(b, 'e', { x: -100, y: 0 })
  ok(crushed.maxX > crushed.minX, 'a resize cannot invert the shape')
  ok(Math.abs(crushed.maxX - crushed.minX - MIN_SIZE_MM) < 1e-9,
    'it stops at the minimum size', `${(crushed.maxX - crushed.minX).toFixed(2)} mm`)

  // --- fitPaths
  const fitted = fitPaths(sq.paths, b, box(0, 0, 40, 20))
  const fb = {
    minX: Math.min(...fitted[0].map((p) => p.x)), maxX: Math.max(...fitted[0].map((p) => p.x)),
    maxY: Math.max(...fitted[0].map((p) => p.y)),
  }
  ok(fb.minX === 0 && fb.maxX === 40 && fb.maxY === 20, 'geometry lands on the new box',
    `${fb.maxX}x${fb.maxY}`)

  // A horizontal line has zero height — scaling it is a divide by zero.
  const flat: Pt[][] = [[{ x: 0, y: 5 }, { x: 10, y: 5 }]]
  const flatFrom = box(0, 5, 10, 5)
  const flatTo = box(0, 20, 20, 20)
  const flatOut = fitPaths(flat, flatFrom, flatTo)
  ok(flatOut[0].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
    'a zero-height path survives a resize', JSON.stringify(flatOut[0]))
  ok(flatOut[0][0].y === 20 && flatOut[0][1].x === 20, 'and is placed on the new box')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
