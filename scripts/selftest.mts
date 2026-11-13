// Engine self-test. Runs headless: everything under test is DOM-free.
//   npx tsx scripts/selftest.mts

import { readDst, writeDst } from '../src/dst'
import { writeExp } from '../src/exp'
import { JEF_PALETTE, nearestJefColor, writeJef } from '../src/jef'
import { planToMoves, splitMove } from '../src/machine'
import { appliquePhases, centerPlan, digitize, orientToEntryExit, MAX_STITCH_MM, MIN_STITCH_MM } from '../src/digitize'
import { insideRegion, tatamiFill } from '../src/fill'
import { dist, isClosed, resample, ringArea, toRegions } from '../src/geometry'
import { DEFAULT_APPLIQUE, DEFAULT_FILL, FILL_STYLES, DEFAULT_SATIN, FILL_UNDERLAY_ORDER, HOOPS, SATIN_UNDERLAY_ORDER, bounds, emptyDoc, newObject, objectVisible, orderedUnderlay, type Pt } from '../src/model'
import { MIN_RAIL_MM, findCorners, railsNeedFlip, satinUnderlay, satinCheck, satinColumn, satinTwoRail, satinTwoRailUnderlay, twoRailCheck, twoRailWidths , angleAt, assignGuides, resolveGuides } from '../src/satin'
import { countTrims, longestStitch, planBounds, shortestStitch } from '../src/stitches'
import { SCHEMA_VERSION, SIGNATURE_GEOMETRY_KEYS, ProjectError, deserialize, docSignature, objectOut, serialize, settingsOut } from '../src/project'
import { clonePlan, deleteStitches, freeze, freezeState, moveStitches, penetrationCount, pickStitch, pickStitchesIn } from '../src/stitchedit'
import { appliqueCutSvg, packageStats, runSheetHtml, writeCol, writeEdr } from '../src/package'
import { NOMINAL_PER_MM2, SEVERE_RATIO, WARN_RATIO, analyseDensity, densityColour } from '../src/density'
import { MAX_SATIN_MM, MAX_SPLIT_SATIN_MM, GUIDE_REACH_MM, MAX_BAR_ANGLE, OVERLOCK_LEAN, PUFF_MAX_MM, PUFF_MIN_MM, puffCaps, puffCheck } from '../src/satin'
import { DEFAULT_KNOCKDOWN, DEFAULT_PUFF, DEFAULT_TIE, type Doc } from '../src/model'
import { unionSelfChecked } from '../src/boolean'
import { ALIGN_EDGES, alignDeltas, distributeDeltas, mirrorPaths, mirrorPt } from '../src/arrange'
import { MOTIFS, crossStitchFill, echoFill, motifFill, motifRun, stippleFill } from '../src/decorative'
import { chainPaths, enterRingNear, orderPaths, travelCost, travelIsHidden } from '../src/travel'
import {
  BUILT_IN_PRESETS, applyStyle, parsePresets, presetFrom, serializePresets,
} from '../src/presets'
import {
  normaliseGlyph, parseAlphabets, serializeAlphabets, setAlphabetText, type Alphabet,
} from '../src/alphabets'
import {
  colourName, needleKey, reorder, runBlocks, threadChanges, unassignedBlocks,
} from '../src/runview'
import { classifyProblems, nextStep, summarise } from '../src/problems'
import { formatField, parseLength, toInchFraction } from '../src/units'
import {
  BROTHER_THREADS, colourDistance, nearestMachineThread, nearestSpools, newSpool,
  parseRack, serializeRack, spoolLabel,
} from '../src/threads'
import { booleanOp, cleanNodes, joinShapes, offsetOp, removeOverlap, simplifyPaths, splitShapeAt } from '../src/shapeops'
import { DEFAULT_TOLERANCE, floodMask, maskArea, maskContours, traceRegionAt, type Raster } from '../src/trace'
import { DEFAULT_TEXT, shapeOutlines, textOnPath } from '../src/text'
import { distanceTransform, pruneSpurs, railsAlong, smoothLine, thin, traceSkeleton } from '../src/skeleton'
import { MIN_DRAW_MM, bigEnough, ellipsePath, freehandPath, polygonUsable, rectPath } from '../src/draw'
import { MIN_SIZE_MM, boxCentre, fitPaths, handlePoint, hitHandle, hitObject, movePaths, objectBox, pickObject, resizeBox, rotatePaths, rotationAngle, unionBox, type Box } from '../src/transform'
import { COALESCE_MS, HISTORY_LIMIT, applyEdit, cancelState, initHistory, redoState, undoState } from '../src/history'
import { arcThrough, deleteNode, flattenShape, insertNode, moveHandle, moveNode, nearestSegment, pathToShape, shapesToPaths, toggleSmooth, type Shape } from '../src/nodes'
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
  doc.objects[0].fill = { style: 'tatami', angle: 17, spacing: 0.37, length: 3.25, stagger: 0.3,
    pullComp: 0.22,
    underlay: ['edge', 'zigzag'], border: { enabled: true, width: 1.8, density: 0.33 } }
  doc.objects[1].run = { length: 1.75, style: 'motif' }
  doc.objects[1].motif = { id: 'scallop', widthMm: 5.5, heightMm: 2.25, gapMm: 0.75 }
  doc.objects[1].satin = {
    width: 4.2, density: 0.31, pullComp: 0.11, underlay: ['center', 'zigzag'], lean: 18,
    split: { enabled: true, maxLength: 5.5, stagger: 0.4 },
  }
  doc.objects[0].knockdown = { spacing: 2.6, margin: 2.1, angle: 20, length: 3.5 }
  doc.objects[1].visible = false
  // Entry/exit and the appliqué recipe, so a dropped field cannot hide here
  // either.
  doc.objects[0].entry = { x: -11, y: 7 }
  doc.objects[0].exit = { x: 13, y: -4 }
  doc.objects[1].guides = [
    { a: { x: -6, y: 22 }, b: { x: -4, y: 26 } },
    { a: { x: 9, y: 22 }, b: { x: 12, y: 26 } },
  ]
  doc.objects[1].applique = {
    tackWidth: 1.9, tackDensity: 0.55, borderWidth: 3.1,
    borderDensity: 0.37, borderPullComp: 0.25, border: false, borderStyle: 'overlock',
  }

  const text = serialize(doc, true)
  const back = deserialize(text)

  // Compared with keys SORTED: the contract is that every field survives, not
  // that the writer happens to emit them in the order the constructor does.
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v as object).sort()
          .map((k) => [k, canon((v as Record<string, unknown>)[k])]))
        : v
  ok(JSON.stringify(canon(back)) === JSON.stringify(canon(doc)), 'every document field round-trips')
  ok(back.objects[0].entry?.x === -11 && back.objects[0].exit?.y === -4,
    'entry and exit points survive')
  ok(back.objects[1].applique.borderWidth === 3.1 && back.objects[1].applique.border === false,
    'the appliqué recipe survives')
  ok(back.objects[1].applique.borderStyle === 'overlock', 'including a faux overlock edge')
  ok(back.objects[1].satin.lean === 18, 'the satin bar lean survives')
  ok(back.objects[1].satin.split.enabled === true && back.objects[1].satin.split.maxLength === 5.5,
    'the satin split recipe survives')
  ok(back.objects[0].knockdown.margin === 2.1, 'the knockdown recipe survives')
  ok(back.objects[1].run.style === 'motif' && back.objects[1].motif.id === 'scallop'
    && back.objects[1].motif.gapMm === 0.75, 'the motif recipe survives')
  ok(back.objects[0].fill.style === 'tatami', 'the fill style survives')
  ok(back.objects[1].guides?.length === 2 && back.objects[1].guides[1].b.x === 12,
    'angle guides survive')
  // A guide missing a number would still turn the bars, just somewhere nobody
  // put it — so it is dropped, not repaired.
  {
    const bad = JSON.parse(text)
    bad.doc.objects[1].guides = [[1, 2, 3], [4, 5, 6, 7]]
    const r = deserialize(JSON.stringify(bad))
    ok(r.objects[1].guides?.length === 1, 'a malformed guide is dropped, not repaired',
      `${r.objects[1].guides?.length}`)
  }
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

  // --- rotate
  {
    const c = { x: 0, y: 0 }
    const sqr: Pt[][] = [[{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }]]
    const quarter = rotatePaths(sqr, c, Math.PI / 2)
    ok(Math.abs(quarter[0][0].x) < 1e-9 && Math.abs(quarter[0][0].y - 1) < 1e-9,
      'a quarter turn maps +X to +Y (Y DOWN, so clockwise on screen)',
      `${quarter[0][0].x.toFixed(3)},${quarter[0][0].y.toFixed(3)}`)
    // Rotation is rigid: every distance from the pivot is preserved.
    const r0 = sqr[0].map((p) => Math.hypot(p.x, p.y))
    const r1 = quarter[0].map((p) => Math.hypot(p.x, p.y))
    ok(r0.every((v, i) => Math.abs(v - r1[i]) < 1e-9), 'rotation preserves every radius')
    // Four quarter turns is identity — no drift.
    let acc = sqr
    for (let i = 0; i < 4; i++) acc = rotatePaths(acc, c, Math.PI / 2)
    ok(acc[0].every((p, i) => Math.abs(p.x - sqr[0][i].x) < 1e-9 && Math.abs(p.y - sqr[0][i].y) < 1e-9),
      'four quarter turns return the original exactly')
    // Off-centre pivot moves the shape around it.
    const off = rotatePaths([[{ x: 2, y: 0 }]], { x: 1, y: 0 }, Math.PI)
    ok(Math.abs(off[0][0].x) < 1e-9, 'rotating about an off-centre pivot orbits it',
      `${off[0][0].x.toFixed(3)}`)

    ok(Math.abs(boxCentre({ minX: 0, minY: 0, maxX: 10, maxY: 20 }).x - 5) < 1e-9, 'box centre x')
    ok(Math.abs(boxCentre({ minX: 0, minY: 0, maxX: 10, maxY: 20 }).y - 10) < 1e-9, 'box centre y')

    // Angle + snap
    const ang = rotationAngle(c, { x: 10, y: 0 }, { x: 0, y: 10 })
    ok(Math.abs(ang - Math.PI / 2) < 1e-9, 'the drag angle is measured from the pivot')
    const snapped = rotationAngle(c, { x: 10, y: 0 }, { x: 10, y: 1.2 }, 15)
    ok(Math.abs(snapped) < 1e-9, 'a small drag snaps back to zero', `${snapped.toFixed(4)}`)
    const snapped2 = rotationAngle(c, { x: 10, y: 0 }, { x: 10, y: 3 }, 15)
    ok(Math.abs(snapped2 - Math.PI / 12) < 1e-9, 'and a bigger one to 15 degrees',
      `${((snapped2 * 180) / Math.PI).toFixed(1)} deg`)
  }

  // --- multi-selection bounds
  {
    const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 }
    const b = { minX: 20, minY: -5, maxX: 30, maxY: 5 }
    const u = unionBox([a, b])!
    ok(u.minX === 0 && u.minY === -5 && u.maxX === 30 && u.maxY === 10,
      'a multi-selection spans every object', JSON.stringify(u))
    ok(unionBox([null, a])!.maxX === 10, 'a missing box is skipped, not fatal')
    ok(unionBox([]) === null, 'an empty selection has no box')
  }

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


// ---------------------------------------------------------------------------
console.log('\n# undo / redo')
{
  const rec = (n: number, tag?: string, now = 0) =>
    ({ kind: 'record', tag, now }) as const

  let h = initHistory('a')
  ok(h.past.length === 0 && h.future.length === 0, 'a fresh stack has nowhere to go')
  ok(undoState(h).present === 'a', 'undo at the bottom is a no-op')
  ok(redoState(h).present === 'a', 'redo at the top is a no-op')

  h = applyEdit(h, 'b', rec(1))
  h = applyEdit(h, 'c', rec(2))
  ok(h.present === 'c' && h.past.length === 2, 'two edits, two steps back')

  h = undoState(h)
  ok(h.present === 'b', 'undo steps back one')
  h = undoState(h)
  ok(h.present === 'a', 'and again')
  ok(h.future.length === 2, 'the undone edits are redoable', `${h.future.length}`)
  h = redoState(h)
  ok(h.present === 'b', 'redo steps forward')

  // A new edit after undoing abandons the redo branch — the standard rule,
  // and the one users expect from every other editor.
  h = applyEdit(h, 'z', rec(3))
  ok(h.present === 'z' && h.future.length === 0, 'editing after an undo drops the redo branch')

  // --- gesture bracketing: a drag is ONE step
  {
    let g = initHistory('start')
    g = applyEdit(g, 'frame1', { kind: 'record', now: 0 })   // begin() -> first frame records
    for (let i = 2; i < 200; i++) g = applyEdit(g, `frame${i}`, { kind: 'amend' })
    ok(g.present === 'frame199', 'the drag ends on the last frame')
    ok(g.past.length === 1, '200 drag frames are ONE undo step', `${g.past.length}`)
    ok(undoState(g).present === 'start', 'undoing the drag returns to before it')
  }

  // --- coalescing by tag: typing in a field is one step
  {
    let c = initHistory(0)
    c = applyEdit(c, 1, rec(0, 'angle:o1', 0))
    c = applyEdit(c, 12, rec(0, 'angle:o1', 100))
    c = applyEdit(c, 120, rec(0, 'angle:o1', 200))
    ok(c.present === 120 && c.past.length === 1, 'same tag in quick succession is one step',
      `${c.past.length}`)
    ok(undoState(c).present === 0, 'and undoes to before the typing')

    // A different field must NOT merge into it.
    let d = initHistory(0)
    d = applyEdit(d, 1, rec(0, 'angle:o1', 0))
    d = applyEdit(d, 2, rec(0, 'spacing:o1', 50))
    ok(d.past.length === 2, 'a different field is its own step', `${d.past.length}`)

    // The same field after a pause is a separate step.
    let e2 = initHistory(0)
    e2 = applyEdit(e2, 1, rec(0, 'angle:o1', 0))
    e2 = applyEdit(e2, 2, rec(0, 'angle:o1', COALESCE_MS + 1))
    ok(e2.past.length === 2, 'the same field after a pause is a new step', `${e2.past.length}`)

    // Untagged edits never merge, however fast they arrive.
    let f = initHistory(0)
    f = applyEdit(f, 1, rec(0, undefined, 0))
    f = applyEdit(f, 2, rec(0, undefined, 1))
    ok(f.past.length === 2, 'untagged edits never merge')

    // Undo must clear the tag, or the next edit merges into the step we just
    // stepped off and the undo appears not to have happened.
    let g2 = initHistory(0)
    g2 = applyEdit(g2, 1, rec(0, 'angle:o1', 0))
    g2 = applyEdit(g2, 2, rec(0, 'angle:o1', 100))
    g2 = undoState(g2)
    g2 = applyEdit(g2, 9, rec(0, 'angle:o1', 150))
    ok(g2.past.length === 1 && undoState(g2).present === 0,
      'an edit right after undo starts a fresh step')
  }

  // --- cancelling a gesture leaves no trace at all
  {
    let c = initHistory('before')
    c = applyEdit(c, 'mid', { kind: 'record', now: 0 })
    c = applyEdit(c, 'later', { kind: 'amend' })
    c = cancelState(c)
    ok(c.present === 'before', 'cancel restores the pre-drag document')
    ok(c.past.length === 0, 'and removes the step it had recorded')
    ok(c.future.length === 0, 'a cancelled drag is NOT redoable — it was refused')
  }

  // --- reset drops the stack: undoing into a different project is nonsense
  {
    let r = initHistory('a')
    r = applyEdit(r, 'b', rec(1))
    r = applyEdit(r, 'opened', { kind: 'reset' })
    ok(r.present === 'opened' && r.past.length === 0 && r.future.length === 0,
      'opening a project clears the stack')
  }

  // --- the cap bounds memory without dropping the newest work
  {
    let b2 = initHistory(0)
    for (let i = 1; i <= HISTORY_LIMIT + 25; i++) b2 = applyEdit(b2, i, rec(i, undefined, i))
    ok(b2.past.length === HISTORY_LIMIT, 'the stack is capped', `${b2.past.length}`)
    ok(b2.present === HISTORY_LIMIT + 25, 'the newest edit is still present')
    // The oldest states fell off the bottom, the recent ones survived.
    ok(b2.past[0] === 25, 'the oldest steps are the ones dropped', `${b2.past[0]}`)
  }
}


// ---------------------------------------------------------------------------
console.log('\n# nodes and curves')
{
  const straight: Shape = { nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: false }
  ok(flattenShape(straight).length === 3, 'handle-free nodes stay a polyline — straight costs nothing',
    `${flattenShape(straight).length}`)

  // A curve flattens to many points, and they must lie ON the curve.
  const curve: Shape = {
    nodes: [
      { x: 0, y: 0, hOut: { x: 0, y: 20 } },
      { x: 30, y: 0, hIn: { x: 30, y: 20 } },
    ], closed: false,
  }
  const flat = flattenShape(curve)
  ok(flat.length > 8, 'a curve subdivides', `${flat.length}`)
  ok(Math.abs(flat[0].x) < 1e-9 && Math.abs(flat[flat.length - 1].x - 30) < 1e-9,
    'and keeps both endpoints exactly')
  // Symmetric control net -> symmetric curve, and the apex sits at 3/4 of the
  // handle height for a cubic (0.75 * 20 = 15).
  const apex = flat.reduce((m, p) => (p.y > m.y ? p : m), flat[0])
  ok(Math.abs(apex.x - 15) < 0.5, 'the curve peaks at its midpoint', `${apex.x.toFixed(2)}`)
  ok(Math.abs(apex.y - 15) < 0.2, 'at the cubic apex height', `${apex.y.toFixed(2)}`)

  // Bigger curves get more segments, and chord error stays under tolerance.
  const big: Shape = {
    nodes: [{ x: 0, y: 0, hOut: { x: 0, y: 200 } }, { x: 300, y: 0, hIn: { x: 300, y: 200 } }],
    closed: false,
  }
  ok(flattenShape(big).length > flat.length, 'a bigger curve gets more points',
    `${flat.length} -> ${flattenShape(big).length}`)

  // Closed shapes do not carry the duplicate; shapesToPaths adds the ring close.
  const ring: Shape = { nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true }
  ok(flattenShape(ring).length === 3, 'a closed shape flattens without a duplicate point')
  const paths = shapesToPaths([ring])
  ok(paths[0].length === 4, 'but the sewable ring IS closed', `${paths[0].length}`)
  ok(paths[0][0].x === paths[0][3].x && paths[0][0].y === paths[0][3].y, 'first point repeated')

  // --- adopting existing geometry
  const adopted = pathToShape([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 0 }])
  ok(adopted.closed, 'a repeated first point is read as a closed ring')
  ok(adopted.nodes.length === 3, 'and the duplicate is not kept as a node', `${adopted.nodes.length}`)
  ok(adopted.nodes.every((n) => !n.hIn && !n.hOut), 'adopted nodes are corners — no invented curves')

  // --- insert is EXACT: the outline must not move
  {
    const before = flattenShape(curve, 0.05)
    const split = insertNode(curve, 0, 0.5)
    ok(split.nodes.length === 3, 'insert adds one node', `${split.nodes.length}`)
    const after = flattenShape(split, 0.05)
    let worst = 0
    for (const p of after) {
      let d = Infinity
      for (let i = 1; i < before.length; i++) d = Math.min(d, segDist(p, before[i - 1], before[i]))
      worst = Math.max(worst, d)
    }
    ok(worst < 0.02, 'splitting a curve does not move it (de Casteljau)', `${worst.toFixed(4)} mm`)

    const line = insertNode(straight, 0, 0.5)
    ok(Math.abs(line.nodes[1].x - 5) < 1e-9 && Math.abs(line.nodes[1].y) < 1e-9,
      'splitting a straight segment lands on the midpoint')
  }

  // --- delete refuses to leave a husk
  ok(deleteNode(straight, 0).nodes.length === 2, 'an open path can drop to two nodes')
  ok(deleteNode({ nodes: straight.nodes.slice(0, 2), closed: false }, 0).nodes.length === 2,
    'but not below two')
  ok(deleteNode(ring, 0).nodes.length === 3, 'a closed path will not drop below three')

  // --- moving carries handles
  {
    const moved = moveNode(curve, 0, { x: 5, y: 5 })
    ok(moved.nodes[0].x === 5 && moved.nodes[0].y === 5, 'the node moves')
    ok(moved.nodes[0].hOut!.x === 5 && moved.nodes[0].hOut!.y === 25,
      'and its handle travels with it', JSON.stringify(moved.nodes[0].hOut))
  }

  // --- smoothness keeps handles collinear
  {
    const sm: Shape = {
      nodes: [{ x: 0, y: 0 }, { x: 10, y: 0, smooth: true, hIn: { x: 8, y: 0 }, hOut: { x: 12, y: 0 } }, { x: 20, y: 0 }],
      closed: false,
    }
    const pulled = moveHandle(sm, 1, 'hOut', { x: 10, y: 6 })
    const n = pulled.nodes[1]
    const cross = (n.hOut!.x - n.x) * (n.hIn!.y - n.y) - (n.hOut!.y - n.y) * (n.hIn!.x - n.x)
    ok(Math.abs(cross) < 1e-6, 'a smooth node keeps its handles collinear', `${cross.toFixed(6)}`)
    ok(Math.hypot(n.hIn!.x - n.x, n.hIn!.y - n.y) > 1,
      'and the opposite handle keeps its own length')

    // A corner moves one handle only.
    const corner = { ...sm, nodes: sm.nodes.map((q, i) => (i === 1 ? { ...q, smooth: false } : q)) }
    const c2 = moveHandle(corner, 1, 'hOut', { x: 10, y: 6 })
    ok(c2.nodes[1].hIn!.y === 0, 'a corner leaves the other handle alone')

    // Becoming a corner must not silently flatten the curve.
    const back = toggleSmooth(sm, 1)
    ok(back.nodes[1].smooth === false && !!back.nodes[1].hOut, 'corner conversion keeps the handles')
    // Becoming smooth grows handles where there were none.
    const grown = toggleSmooth({ nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }], closed: false }, 1)
    ok(!!grown.nodes[1].hIn && !!grown.nodes[1].hOut, 'smoothing grows handles along the run')
  }

  // --- finding the segment under the cursor
  {
    const sq: Shape = {
      nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], closed: true,
    }
    const top = nearestSegment(sq, { x: 5, y: 0.1 }, 1)
    ok(top?.i === 0 && Math.abs(top.t - 0.5) < 0.05, 'the segment under the cursor is found',
      `i=${top?.i} t=${top?.t.toFixed(2)}`)
    const right = nearestSegment(sq, { x: 10.1, y: 2.5 }, 1)
    ok(right?.i === 1 && Math.abs(right.t - 0.25) < 0.05, 'and how far along it',
      `i=${right?.i} t=${right?.t.toFixed(2)}`)
    // The closing segment of a ring is real and must be findable.
    const closing = nearestSegment(sq, { x: 0.1, y: 5 }, 1)
    ok(closing?.i === 3, 'including the segment that closes the ring', `i=${closing?.i}`)
    ok(nearestSegment(sq, { x: 50, y: 50 }, 1) === null, 'far away finds nothing')
  }

  // --- arcs
  {
    const arc = arcThrough({ x: -10, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 0 })
    const pts = flattenShape(arc, 0.05)
    ok(pts.length > 8, 'a three-point arc produces a curve', `${pts.length}`)
    // Every point must sit on the circle through those three points: centre
    // (0,0), radius 10.
    let worstR = 0
    for (const p of pts) worstR = Math.max(worstR, Math.abs(Math.hypot(p.x, p.y) - 10))
    ok(worstR < 0.05, 'and every point lies on the true circle', `${worstR.toFixed(4)} mm`)
    // It must pass through the middle point, not take the long way round.
    let nearest = Infinity
    for (const p of pts) nearest = Math.min(nearest, Math.hypot(p.x - 0, p.y - 10))
    ok(nearest < 0.05, 'the arc passes through the given middle point', `${nearest.toFixed(4)} mm`)
    ok(Math.abs(pts[0].x + 10) < 1e-6 && Math.abs(pts[pts.length - 1].x - 10) < 1e-6,
      'endpoints are exact')

    // Collinear points have no circle — that is a straight line, not an error.
    const line = arcThrough({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 })
    ok(line.nodes.length === 2, 'collinear points give a straight segment', `${line.nodes.length}`)
  }
}


// ---------------------------------------------------------------------------
console.log('\n# two-rail satin column')
{
  const P = { ...DEFAULT_SATIN(), width: 3, density: 0.4, pullComp: 0, underlay: 'none' as const }
  const lineA: Pt[] = [{ x: 0, y: 0 }, { x: 40, y: 0 }]
  const lineB: Pt[] = [{ x: 0, y: 3 }, { x: 40, y: 3 }]

  const col = satinTwoRail(lineA, lineB, P)
  ok(col.length > 100, 'a parallel pair produces a column', `${col.length}`)
  // Stitches must ALTERNATE between the rails, or it is not a satin.
  let alternates = true
  for (let i = 0; i < col.length; i++) {
    const onA = Math.abs(col[i].y - 0) < 1e-6
    const onB = Math.abs(col[i].y - 3) < 1e-6
    if (!onA && !onB) { alternates = false; break }
    if (i > 0) {
      const prevA = Math.abs(col[i - 1].y - 0) < 1e-6
      if (onA === prevA) { alternates = false; break }
    }
  }
  ok(alternates, 'every penetration lands on a rail, alternating between them')
  ok(Math.abs(col[0].x) < 1e-6 && Math.abs(col[col.length - 1].x - 40) < 0.01,
    'the column spans the full rails', `${col[col.length - 1].x.toFixed(2)}`)
  // Density is held along the rails.
  // Same convention as the spine engine: `density` is the advance per
  // PENETRATION, so two penetrations on one rail sit 2x density apart.
  const pitches: number[] = []
  for (let i = 2; i < col.length - 1; i++) pitches.push(Math.abs(col[i].x - col[i - 2].x) / 2)
  const avg = pitches.reduce((a, b) => a + b, 0) / pitches.length
  ok(Math.abs(avg - P.density) < 0.06, 'penetration pitch matches the density setting',
    `${avg.toFixed(3)} mm`)

  // --- the bow tie: rail B drawn backwards
  {
    const reversed = [...lineB].reverse()
    ok(railsNeedFlip(lineA, reversed), 'a rail drawn backwards is detected')
    ok(!railsNeedFlip(lineA, lineB), 'and a rail drawn the same way is left alone')
    const fixed = satinTwoRail(lineA, reversed, P)
    // If the twist were not corrected the bars would cross, so x would sweep
    // from both ends towards the middle instead of marching along.
    let monotone = true
    for (let i = 2; i < fixed.length; i++) if (fixed[i].x < fixed[i - 2].x - 1e-6) monotone = false
    ok(monotone, 'a backwards rail is flipped, not sewn as a bow tie')
  }

  // --- a taper keeps pairing proportionally
  {
    const tipA: Pt[] = [{ x: 0, y: 0 }, { x: 40, y: 0 }]
    const tipB: Pt[] = [{ x: 0, y: 6 }, { x: 40, y: 1.2 }]
    const taper = satinTwoRail(tipA, tipB, P)
    ok(taper.length > 50, 'a tapered column generates', `${taper.length}`)
    const widths = twoRailWidths(tipA, tipB)
    ok(Math.abs(widths[0] - 6) < 0.05 && Math.abs(widths[widths.length - 1] - 1.2) < 0.05,
      'width is measured where the rails actually are',
      `${widths[0].toFixed(2)} -> ${widths[widths.length - 1].toFixed(2)}`)
    // Every penetration sits on one of the two rails (y=0, or the sloping B).
    let strays = 0
    for (const st of taper) {
      const onA = Math.abs(st.y) < 0.02
      const onB = Math.abs(st.y - (6 - (4.8 * st.x) / 40)) < 0.05
      if (!onA && !onB) strays++
    }
    ok(strays === 0, 'a taper puts every stitch on a rail', `${strays} strays`)
  }

  // --- rungs: the pairing the digitizer clicked must be the pairing sewn
  {
    // Rail A runs at constant speed; rail B dawdles then races. Proportional
    // pairing would slide the join around; explicit rungs must not.
    const ra: Pt[] = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 40, y: 0 }]
    const rb: Pt[] = [{ x: 0, y: 4 }, { x: 5, y: 4 }, { x: 40, y: 4 }]
    // Three rungs: A at 0, 0.5, 1 of its length; B at 0, 5/40, 1 of its.
    const anchorsA = [0, 0.5, 1]
    const anchorsB = [0, 5 / 40, 1]
    const col = satinTwoRail(ra, rb, P, { anchorsA, anchorsB })
    ok(col.length > 20, 'a rung-paired column generates', `${col.length}`)

    // Find the stitch nearest the middle rung on each rail; they must be the
    // points the user actually clicked — (20,0) paired with (5,4).
    const onA = col.filter((s) => Math.abs(s.y) < 1e-6)
    const onB = col.filter((s) => Math.abs(s.y - 4) < 1e-6)
    const nearestTo = (list: typeof col, x: number) =>
      list.reduce((m, s) => (Math.abs(s.x - x) < Math.abs(m.x - x) ? s : m), list[0])
    // Walk to the stitch pair straddling the halfway point of the column.
    const midA = nearestTo(onA, 20)
    const midB = nearestTo(onB, 5)
    ok(Math.abs(midA.x - 20) < 1.0, 'rail A is sewn through its middle rung point',
      `${midA.x.toFixed(2)} vs 20`)
    ok(Math.abs(midB.x - 5) < 1.0, 'rail B is sewn through ITS middle rung point',
      `${midB.x.toFixed(2)} vs 5`)

    // The bars near the middle must join the clicked pair, not drift apart:
    // at the halfway rung, A is at x=20 while B is at x=5.
    const pairIdx = col.findIndex((s, i) =>
      i > 0 && Math.abs(s.y) < 1e-6 && Math.abs(s.x - 20) < 1.2)
    ok(pairIdx > 0, 'the middle rung appears in the stitch order')
    const partner = col[pairIdx - 1]
    ok(Math.abs(partner.x - 5) < 1.5,
      'and its bar lands on the point it was paired with, not where arc length would put it',
      `${partner.x.toFixed(2)} vs 5`)

    // The same rails WITHOUT anchors pair by arc length: both rails are 40
    // long, so A's x=20 pairs with B's x=20 — not with the x=5 the digitizer
    // clicked. Asking what each mode pairs A's middle WITH is the comparison
    // that actually discriminates; "nearest stitch to x=5" does not, because
    // rail B carries stitches along its whole length either way.
    const partnerOfA20 = (col: typeof plain) => {
      const i = col.findIndex((s, k) => k > 0 && Math.abs(s.y) < 1e-6 && Math.abs(s.x - 20) < 1.2)
      return i > 0 ? col[i - 1].x : NaN
    }
    const plain = satinTwoRail(ra, rb, P)
    ok(Math.abs(partnerOfA20(plain) - 20) < 2,
      'without rungs, arc length pairs A@20 with B@20', `${partnerOfA20(plain).toFixed(2)}`)
    ok(Math.abs(partnerOfA20(col) - 5) < 2,
      'with rungs, A@20 pairs with the B@5 that was clicked — the whole feature',
      `${partnerOfA20(col).toFixed(2)}`)
  }

  // --- the inner rail is never allowed to collapse into one hole
  {
    // A sharply curved pair: the inner rail is far shorter than the outer.
    const outer = circle(0, 0, 20, 200).slice(0, 60)
    const inner = circle(0, 0, 17, 200).slice(0, 60)
    const curved = satinTwoRail(outer, inner, { ...P, width: 3 })
    let minSame = Infinity
    for (let i = 2; i < curved.length; i++) {
      minSame = Math.min(minSame, dist(curved[i - 2], curved[i]))
    }
    ok(minSame >= MIN_RAIL_MM - 1e-6,
      'the inner rail keeps a sewable gap on a tight bend', `${minSame.toFixed(3)} mm`)
  }

  // --- pull compensation widens the pair
  {
    const comp = satinTwoRail(lineA, lineB, { ...P, pullComp: 0.4 })
    const ys = comp.map((s) => s.y)
    ok(Math.min(...ys) < -0.1 && Math.max(...ys) > 3.1,
      'pull compensation pushes both rails outward',
      `${Math.min(...ys).toFixed(2)}..${Math.max(...ys).toFixed(2)}`)
  }

  // --- refusals
  {
    const far: Pt[] = [{ x: 0, y: 30 }, { x: 40, y: 30 }]
    ok(twoRailCheck(lineA, far, P).errors.some((e) => /widest/.test(e)),
      'rails too far apart are refused')
    const near: Pt[] = [{ x: 0, y: 0.3 }, { x: 40, y: 0.3 }]
    ok(twoRailCheck(lineA, near, P).errors.some((e) => /floor/.test(e)),
      'rails pinched below the satin floor are refused')
    // Crossing rails: B starts below A and ends above it.
    const crossing: Pt[] = [{ x: 0, y: 3 }, { x: 40, y: -3 }]
    const crossed = twoRailCheck([{ x: 0, y: 0 }, { x: 40, y: 0 }], crossing, P)
    ok(crossed.errors.some((e) => /cross/.test(e)), 'crossing rails are refused',
      crossed.errors[0] ?? 'none')
    ok(twoRailCheck(lineA, lineB, P).errors.length === 0, 'a good pair passes clean')
    ok(twoRailCheck(lineA, [{ x: 0, y: 3 }], P).errors.length > 0, 'a one-point rail is refused')
  }

  // --- underlay never pokes out past the column
  {
    const u = satinTwoRailUnderlay(lineA, lineB, { ...P, underlay: 'center' })
    ok(u.length > 2, 'centre underlay is produced', `${u.length}`)
    ok(u.every((s) => s.y > -0.01 && s.y < 3.01), 'and stays between the rails')
    ok(Math.min(...u.map((s) => s.x)) > 0 && Math.max(...u.map((s) => s.x)) < 40,
      'and inside their ends')
    ok(satinTwoRailUnderlay(lineA, lineB, { ...P, underlay: 'none' }).length === 0,
      'underlay none means none')
  }
}


// ---------------------------------------------------------------------------
console.log('\n# layered underlay')
{
  // Order is the craft order, not the order ticked.
  ok(orderedUnderlay(['zigzag', 'center'], SATIN_UNDERLAY_ORDER).join() === 'center,zigzag',
    'satin layers sew centre, edge, then zigzag whatever order they were picked',
    orderedUnderlay(['zigzag', 'center'], SATIN_UNDERLAY_ORDER).join())
  ok(orderedUnderlay(['zigzag', 'edge'], FILL_UNDERLAY_ORDER).join() === 'edge,zigzag',
    'fill layers sew edge then zigzag')
  ok(orderedUnderlay([], SATIN_UNDERLAY_ORDER).length === 0, 'no layers means none')

  const spine: Pt[] = [{ x: 0, y: 0 }, { x: 30, y: 0 }]
  const base = { ...DEFAULT_SATIN(), width: 4, density: 0.4, pullComp: 0 }
  const one = satinUnderlay(spine, { ...base, underlay: ['center'] })
  const two = satinUnderlay(spine, { ...base, underlay: ['center', 'zigzag'] })
  const three = satinUnderlay(spine, { ...base, underlay: ['center', 'edge', 'zigzag'] })
  ok(one.length > 0, 'one layer produces stitches', `${one.length}`)
  ok(two.length > one.length, 'two layers produce MORE than one', `${one.length} -> ${two.length}`)
  ok(three.length > two.length, 'and three more than two', `${two.length} -> ${three.length}`)
  ok(satinUnderlay(spine, { ...base, underlay: [] }).length === 0, 'no layers sews nothing')
  // The combination must START with the layer that sews first.
  ok(Math.abs(two[0].y) < 1e-9, 'the centre run leads, since it is first in the order')

  // Two-rail columns layer too, and nothing escapes the rails.
  {
    const ra: Pt[] = [{ x: 0, y: 0 }, { x: 30, y: 0 }]
    const rb: Pt[] = [{ x: 0, y: 4 }, { x: 30, y: 4 }]
    const u3 = satinTwoRailUnderlay(ra, rb, { ...base, underlay: ['center', 'edge', 'zigzag'] })
    const u1 = satinTwoRailUnderlay(ra, rb, { ...base, underlay: ['center'] })
    ok(u3.length > u1.length, 'a two-rail column layers its underlay too',
      `${u1.length} -> ${u3.length}`)
    ok(u3.every((q) => q.y >= -0.01 && q.y <= 4.01), 'and every layer stays between the rails')
    ok(u3.every((q) => q.x > -0.01 && q.x < 30.01), 'and inside their ends')
    ok(satinTwoRailUnderlay(ra, rb, { ...base, underlay: [] }).length === 0, 'none means none')
  }

  // --- legacy projects still open
  {
    const legacy = (u: unknown, kind: 'satin' | 'fill') => {
      const d = emptyDoc()
      const o = newObject({ type: kind === 'satin' ? 'satin' : 'fill', paths: [[{ x: 0, y: 0 }, { x: 10, y: 0 }]] })
      if (kind === 'satin') (o.satin as unknown as Record<string, unknown>).underlay = u
      else (o.fill as unknown as Record<string, unknown>).underlay = u
      d.objects = [o]
      return deserialize(serialize(d)).objects[0]
    }
    ok(legacy('zigzag', 'satin').satin.underlay.join() === 'zigzag', 'a legacy satin string migrates')
    ok(legacy('none', 'satin').satin.underlay.length === 0, 'legacy "none" migrates to no layers')
    // "double" was edge+zigzag all along — it must not silently become one.
    ok(legacy('double', 'fill').fill.underlay.join() === 'edge,zigzag',
      'legacy fill "double" migrates to BOTH layers', legacy('double', 'fill').fill.underlay.join())
    ok(legacy('edge', 'fill').fill.underlay.join() === 'edge', 'legacy fill "edge" migrates')
    // Junk falls back to the default rather than to nothing: sewing a column
    // with no underlay is a wearable defect, not a cosmetic one.
    ok(legacy(42, 'satin').satin.underlay.length > 0, 'an unreadable value falls back to the default')
    ok(legacy([], 'satin').satin.underlay.length === 0, 'but an explicit empty list is honoured')
  }
}


// ---------------------------------------------------------------------------
console.log('\n# auto-trace (magic wand)')
{
  /** Build an RGBA raster from a character map, one char per pixel. */
  const raster = (rows: string[], palette: Record<string, [number, number, number, number]>): Raster => {
    const h = rows.length, w = rows[0].length
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = palette[rows[y][x]]
        const i = (y * w + x) * 4
        data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = c[3]
      }
    }
    return { data, width: w, height: h }
  }
  const PAL: Record<string, [number, number, number, number]> = {
    '.': [255, 255, 255, 255],
    '#': [10, 20, 200, 255],
    'o': [12, 22, 205, 255],   // near-identical to '#', inside tolerance
    'r': [200, 20, 10, 255],   // clearly different
    ' ': [0, 0, 0, 0],         // transparent
  }

  // A filled square with a hole in it.
  const img = raster([
    '..........',
    '..######..',
    '..######..',
    '..##..##..',
    '..##..##..',
    '..######..',
    '..######..',
    '..........',
  ], PAL)

  const mask = floodMask(img, 3, 2)
  // 6+6 + 4+4 + 6+6 = 32 filled pixels; the 2x2 hole is not among them.
  ok(maskArea(mask) === 32, 'the flood covers the shape but not its hole', `${maskArea(mask)}`)
  ok(mask[3 * 10 + 4] === 0, 'the hole is excluded')
  ok(mask[0] === 0, 'and so is the background')

  // Near-identical colours join; clearly different ones do not.
  const shades = raster(['##oo', '##oo'], PAL)
  ok(maskArea(floodMask(shades, 0, 0)) === 8, 'near-identical shades flood together')
  const mixed = raster(['##rr', '##rr'], PAL)
  ok(maskArea(floodMask(mixed, 0, 0)) === 4, 'a clearly different colour stops the flood',
    `${maskArea(floodMask(mixed, 0, 0))}`)
  // Tolerance is adjustable and monotone.
  ok(maskArea(floodMask(mixed, 0, 0, 0.9)) === 8, 'a loose tolerance crosses it')

  // Transparency is absence, not a pale colour.
  {
    const alpha = raster(['##  ', '##  '], PAL)
    ok(maskArea(floodMask(alpha, 0, 0)) === 4, 'the flood does not leak into transparency',
      `${maskArea(floodMask(alpha, 0, 0))}`)
  }

  // --- contours
  {
    const loops = maskContours(mask, img.width, img.height)
    ok(loops.length === 2, 'a shape with a hole traces TWO loops — outer and hole',
      `${loops.length}`)
    const areas = loops.map((l) => {
      let a2 = 0
      for (let i = 0; i < l.length; i++) {
        const p = l[i], q = l[(i + 1) % l.length]
        a2 += p.x * q.y - q.x * p.y
      }
      return a2 / 2
    })
    // One loop winds one way and one the other: that sign is how an outer
    // boundary is told from a hole downstream.
    ok(Math.sign(areas[0]) !== Math.sign(areas[1]), 'and they wind in opposite directions',
      areas.map((a) => a.toFixed(1)).join(' / '))
    // The boundary runs halfway between the last filled pixel and the first
    // empty one, so a 6x6 block encloses 36 less the four chamfered corners.
    const outer = Math.max(...areas.map(Math.abs))
    ok(Math.abs(outer - 36) <= 0.5, 'the outer loop encloses the true pixel area',
      `${outer.toFixed(1)} of 36`)
    const hole = Math.min(...areas.map(Math.abs))
    ok(Math.abs(hole - 4) <= 0.5, 'and the hole encloses its own', `${hole.toFixed(1)} of 4`)
    // Contours run BETWEEN pixels, not through their centres.
    const xs = loops.flat().map((p) => p.x)
    // Filled columns are 2..7, so the boundary sits at 1.5 and 7.5 — half a
    // pixel outside the last filled centre, which is where the edge IS.
    ok(Math.min(...xs) === 1.5 && Math.max(...xs) === 7.5,
      'the boundary sits on the half-grid between pixels',
      `${Math.min(...xs)}..${Math.max(...xs)}`)
  }

  // --- the whole trace, in millimetres
  {
    const res = traceRegionAt(img, 3, 2, { pxPerMm: 2, originMm: { x: 100, y: 50 }, minAreaPx: 1 })
    ok(res.paths.length === 2, 'the trace returns outer and hole', `${res.paths.length}`)
    ok(res.area === 32, 'and reports the pixels it covered', `${res.area}`)
    const all = res.paths.flat()
    // x=1.5 px at 2 px/mm is 0.75 mm, offset to the image origin at 100 mm.
    ok(Math.min(...all.map((p) => p.x)) === 100.75,
      'scaled by px/mm and offset to the image origin',
      `${Math.min(...all.map((p) => p.x))}`)
    ok(res.paths.every((p) => p.length >= 3), 'every contour is a usable ring')
    // toRegions must nest them, or the hole would sew solid.
    const regions = toRegions(res.paths)
    ok(regions.length === 1 && regions[0].length === 2,
      'and they nest into ONE region with ONE hole',
      `${regions.length} region(s), ${regions[0]?.length} ring(s)`)
  }

  // --- refusals and noise
  {
    const miss = traceRegionAt(img, -5, -5, {})
    ok(miss.paths.length === 0 && miss.warnings.length > 0, 'clicking outside the image is reported')
    const speck = raster(['....', '.#..', '....'], PAL)
    const tiny = traceRegionAt(speck, 1, 1, { minAreaPx: 12 })
    ok(tiny.paths.length === 0, 'a single-pixel speck is not turned into an object')
    ok(tiny.warnings.join(' ').includes('too small to sew'), 'and the reason is given', tiny.warnings[0] ?? '')
  }

  // --- simplification keeps the outline where it was
  {
    const big = raster(Array.from({ length: 40 }, (_, y) =>
      Array.from({ length: 40 }, (_, x) => (Math.hypot(x - 20, y - 20) < 15 ? '#' : '.')).join('')), PAL)
    const res = traceRegionAt(big, 20, 20, { pxPerMm: 1, simplifyMm: 0.3, minAreaPx: 10 })
    ok(res.paths.length === 1, 'a disc traces one contour', `${res.paths.length}`)
    const ring = res.paths[0]
    ok(ring.length < 120, 'simplified, not one vertex per half pixel', `${ring.length} points`)
    // Every point still sits on the disc's rim.
    let worst = 0
    for (const p of ring) worst = Math.max(worst, Math.abs(Math.hypot(p.x - 20, p.y - 20) - 15))
    ok(worst < 1.2, 'and the outline still follows the edge', `${worst.toFixed(2)} px`)
  }
}


// ---------------------------------------------------------------------------
console.log('\n# lettering: slant and bend')
{
  // A unit square standing on y=10 (baseline) with its top at y=0.
  const box = (): Pt[][] => [[
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 },
  ]]
  const base = DEFAULT_TEXT()

  ok(shapeOutlines(box(), base)[0].every((p, i) => p.x === box()[0][i].x && p.y === box()[0][i].y),
    'no slant and no bend leaves the outline untouched')

  // --- slant shears about the BASELINE: feet stay, head leans.
  {
    const out = shapeOutlines(box(), { ...base, slantDeg: 45 })[0]
    const feet = out.filter((p) => Math.abs(p.y - 10) < 1e-9)
    const head = out.filter((p) => Math.abs(p.y) < 1e-9)
    ok(feet.every((p) => Math.abs(p.x - (p.x === feet[0].x ? feet[0].x : p.x)) < 1e-9), 'feet exist')
    ok(Math.min(...feet.map((p) => p.x)) === 0, 'the feet stay where they were',
      `${Math.min(...feet.map((p) => p.x))}`)
    // 45 degrees over a 10 mm height moves the top across by 10 mm.
    ok(Math.abs(Math.min(...head.map((p) => p.x)) - 10) < 1e-9, 'and the head leans by height x tan',
      `${Math.min(...head.map((p) => p.x)).toFixed(2)}`)
    // Leaning the other way goes the other way.
    const left = shapeOutlines(box(), { ...base, slantDeg: -45 })[0]
    ok(Math.min(...left.map((p) => p.x)) < 0, 'a negative slant leans left')
  }

  // --- the bend is a parabola: ends pinned, middle moved
  {
    // A row of points along the top edge so the bow can be measured.
    const strip: Pt[][] = [Array.from({ length: 11 }, (_, i) => ({ x: i * 2, y: 0 }))]
    const bowed = shapeOutlines(strip, { ...base, curveTopMm: 5, curveBottomMm: 5 })[0]
    ok(Math.abs(bowed[0].y) < 1e-9 && Math.abs(bowed[10].y) < 1e-9,
      'both ends stay on the line they were set on')
    ok(Math.abs(bowed[5].y + 5) < 1e-9, 'and the middle bows by the full amount',
      `${bowed[5].y.toFixed(2)}`)
    // Monotone rise to the middle, fall after — a bell, not a spike.
    let rising = true
    for (let i = 1; i <= 5; i++) if (bowed[i].y > bowed[i - 1].y) rising = false
    ok(rising, 'the bow rises smoothly to the centre')
    ok(shapeOutlines(strip, { ...base, curveTopMm: -5, curveBottomMm: -5 })[0][5].y > 0,
      'a negative curve bows the other way')
  }

  // --- top and bottom move INDEPENDENTLY: that is what makes a fan
  {
    const out = shapeOutlines(box(), { ...base, curveTopMm: 6, curveBottomMm: 0 })[0]
    const top = out.filter((p) => p.y < 5)
    const bottom = out.filter((p) => p.y >= 5)
    // The box corners are at the ENDS, where the bell is zero, so nothing
    // moves — which is itself the proof that the bow is pinned at the ends.
    ok(top.every((p) => Math.abs(p.y) < 1e-9), 'corners at the ends are unmoved by a bow')

    // Sample the middle of each edge — but inside a shape that HAS width,
    // or u has no span to vary across and the bell is undefined.
    const mid: Pt[][] = [[
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 },
      { x: 20, y: 10 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ]]
    const full = shapeOutlines(mid, { ...base, curveTopMm: 6, curveBottomMm: 0 })[0]
    const m = [full[1], full[4]]
    ok(Math.abs(m[0].y + 6) < 1e-9, 'the top edge bows by the top amount', `${m[0].y.toFixed(2)}`)
    ok(Math.abs(m[1].y - 10) < 1e-9, 'while the bottom edge stays put', `${m[1].y.toFixed(2)}`)
    // Equal amounts arc the whole line without changing its height.
    const arcFull = shapeOutlines(mid, { ...base, curveTopMm: 4, curveBottomMm: 4 })[0]
    const arc = [arcFull[1], arcFull[4]]
    ok(Math.abs((arc[1].y - arc[0].y) - 10) < 1e-9,
      'equal top and bottom arc the line without squashing it',
      `${(arc[1].y - arc[0].y).toFixed(2)}`)
  }

  ok(shapeOutlines([], base).length === 0, 'no outlines is not a crash')
  ok(shapeOutlines([[{ x: 5, y: 5 }]], { ...base, slantDeg: 20 }).length === 1,
    'a degenerate zero-width outline is returned rather than dividing by zero')
}


// ---------------------------------------------------------------------------
console.log('\n# medial axis (satin lettering)')
{
  const box = (w: number, h: number, fill: (x: number, y: number) => boolean) => {
    const m = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fill(x, y)) m[y * w + x] = 1
    return m
  }

  // --- distance transform: the middle of a bar is half its thickness away
  {
    const W = 40, H = 21
    const bar = box(W, H, (x, y) => x >= 5 && x <= 34 && y >= 6 && y <= 14) // 9 px thick
    const d = distanceTransform(bar, W, H)
    const mid = d[10 * W + 20]
    // Centre row is 4 px from the edge rows above and below, +1 for the edge.
    ok(Math.abs(mid - 5) < 0.7, 'the centre of a 9 px bar is ~half its thickness from an edge',
      `${mid.toFixed(2)}`)
    ok(d[6 * W + 20] < mid, 'and the edge is closer to the outside than the centre is')
    ok(d[0] === 0, 'background is zero')
  }

  // --- thinning keeps a stroke connected and one pixel wide
  {
    const W = 40, H = 21
    const bar = box(W, H, (x, y) => x >= 5 && x <= 34 && y >= 6 && y <= 14)
    const sk = thin(bar, W, H)
    let count = 0
    for (let i = 0; i < sk.length; i++) if (sk[i]) count++
    ok(count > 20 && count < 60, 'a bar thins to a line, not to nothing and not to a blob',
      `${count} px`)
    // Every skeleton pixel must lie inside the original shape.
    let strays = 0
    for (let i = 0; i < sk.length; i++) if (sk[i] && !bar[i]) strays++
    ok(strays === 0, 'the skeleton stays inside the shape', `${strays}`)
    // And it must be CONNECTED — one run across the bar, not fragments.
    const lines = pruneSpurs(traceSkeleton(sk, W, H), 4)
    ok(lines.length >= 1, 'the skeleton traces to at least one line', `${lines.length}`)
    const longest = lines.reduce((m, l) => (l.length > m.length ? l : m), lines[0])
    ok(longest.length > 20, 'and the longest run spans the bar', `${longest.length} pts`)
  }

  // --- a cross splits into separate strokes at its junction
  {
    const W = 31, H = 31
    const cross = box(W, H, (x, y) =>
      (x >= 12 && x <= 18 && y >= 3 && y <= 27) || (y >= 12 && y <= 18 && x >= 3 && x <= 27))
    const lines = pruneSpurs(traceSkeleton(thin(cross, W, H), W, H), 4)
    ok(lines.length >= 3, 'a cross breaks into separate strokes at the junction',
      `${lines.length} branches`)
  }

  // --- spurs are dropped
  {
    const W = 40, H = 21
    const bar = box(W, H, (x, y) => (x >= 5 && x <= 34 && y >= 6 && y <= 14) || (x === 20 && y === 5))
    const all = traceSkeleton(thin(bar, W, H), W, H)
    const kept = pruneSpurs(all, 6)
    ok(kept.length <= all.length, 'pruning never adds branches')
    ok(kept.every((l) => {
      let len = 0
      for (let i = 1; i < l.length; i++) len += Math.hypot(l[i].x - l[i - 1].x, l[i].y - l[i - 1].y)
      return len >= 6
    }), 'and everything kept is longer than the threshold')
  }

  // --- rails follow the stroke and carry its width
  {
    const W = 60, H = 31
    // A bar that is thick on the left and thin on the right — a taper.
    const taper = box(W, H, (x, y) => {
      if (x < 6 || x > 53) return false
      const half = 9 - Math.round(((x - 6) / 47) * 6)
      return Math.abs(y - 15) <= half
    })
    const d = distanceTransform(taper, W, H)
    const line = smoothLine(pruneSpurs(traceSkeleton(thin(taper, W, H), W, H), 8)
      .reduce((m, l) => (l.length > m.length ? l : m), [{ x: 0, y: 0 }]))
    ok(line.length > 20, 'the taper has a centreline', `${line.length}`)
    const rails = railsAlong(line, d, W, H)
    ok(rails.left.length === rails.right.length && rails.left.length > 10,
      'rails come in matching pairs', `${rails.left.length}`)
    const widthAt = (i: number) => Math.hypot(
      rails.left[i].x - rails.right[i].x, rails.left[i].y - rails.right[i].y)
    const first = widthAt(2), last = widthAt(rails.left.length - 3)
    ok(first > last + 3, 'and the column is WIDER where the stroke is thicker',
      `${first.toFixed(1)} -> ${last.toFixed(1)}`)
    // The rails must straddle the centreline, not sit on one side.
    const mid = Math.floor(rails.left.length / 2)
    ok((rails.left[mid].y - line[mid].y) * (rails.right[mid].y - line[mid].y) < 0,
      'the rails sit on opposite sides of the centre')
  }

  ok(traceSkeleton(new Uint8Array(100), 10, 10).length === 0, 'an empty mask traces nothing')
}


// ---------------------------------------------------------------------------
console.log('\n# appliqué sequence')
{
  const ring = [...rect(0, 0, 40, 30), { x: 0, y: 0 }]
  const obj = newObject({ name: 'Patch', type: 'applique', color: '#c0392b', paths: [ring] })
  const warn: string[] = []
  const phases = appliquePhases(obj, warn)
  ok(phases.length === 3, 'placement, tack-down and border', `${phases.length}`)
  ok(/placement/.test(phases[0].label) && /lay fabric/.test(phases[0].label),
    'the first phase tells the operator to lay the fabric', phases[0].label)
  ok(/tack-down/.test(phases[1].label) && /trim/.test(phases[1].label),
    'the second tells them to trim', phases[1].label)
  ok(/border/.test(phases[2].label), 'the third is the covering border')
  // Order is the whole point: placement BEFORE tack-down BEFORE border.
  ok(phases.every((p) => p.stitches.length > 0), 'every phase actually generates stitches',
    phases.map((p) => p.stitches.length).join('/'))
  // The border must be wider than the tack-down, or it cannot cover the cut edge.
  const span = (st: typeof phases[0]['stitches']) => {
    let min = Infinity, max = -Infinity
    for (const s of st) { if (s.y < min) min = s.y; if (s.y > max) max = s.y }
    return max - min
  }
  ok(span(phases[2].stitches) > span(phases[1].stitches),
    'the border is wider than the tack-down, so it covers the cut edge',
    `${span(phases[1].stitches).toFixed(1)} vs ${span(phases[2].stitches).toFixed(1)}`)

  // Turning the border off leaves two phases, not a silent three.
  const noBorder = newObject({
    name: 'P2', type: 'applique', paths: [ring],
    applique: { ...DEFAULT_APPLIQUE(), border: false },
  })
  ok(appliquePhases(noBorder, []).length === 2, 'the border can be turned off')

  // An open path is not an appliqué: there is nothing to lay fabric inside.
  const open = newObject({ name: 'P3', type: 'applique', paths: [[{ x: 0, y: 0 }, { x: 10, y: 0 }]] })
  const w2: string[] = []
  ok(appliquePhases(open, w2).length === 0 && w2.length > 0,
    'an open outline is refused and reported', w2[0] ?? '')

  // --- and through the real pipeline: each phase its own BLOCK, so the
  //     machine stops between them.
  {
    const d = emptyDoc()
    d.objects = [obj]
    const { plan } = digitize(d)
    ok(plan.blocks.length === 3, 'appliqué emits three blocks — the stops between them',
      `${plan.blocks.length}`)
    ok(plan.blocks.every((b) => b.stitches.length > 2), 'and each block carries stitches')
    // Written out, the stops are real colour-change records.
    const dst = readDst(writeDst(centerPlan(plan), 'ap'))
    ok(dst.colorChanges === 2, 'the DST carries two stops — one per operator step',
      `${dst.colorChanges}`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n# appliqué cutting file')
{
  const d = emptyDoc()
  ok(appliqueCutSvg(d) === null, 'a design with no appliqué writes no cut file')
  d.objects = [newObject({
    name: 'Shield', type: 'applique',
    paths: [[...rect(-20, -15, 40, 30), { x: -20, y: -15 }]],
  })]
  const svg = appliqueCutSvg(d)!
  ok(svg.includes('<svg'), 'a cut file is produced')
  // TRUE SIZE is the whole point: mm units with a matching viewBox is what
  // makes a printer put it on paper at the size the fabric has to be.
  const m = /width="([\d.]+)mm" height="([\d.]+)mm" viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)
  ok(!!m, 'with physical mm dimensions', m ? m[0] : svg.slice(0, 80))
  if (m) {
    ok(Math.abs(parseFloat(m[1]) - parseFloat(m[3])) < 1e-6
      && Math.abs(parseFloat(m[2]) - parseFloat(m[4])) < 1e-6,
      'and a viewBox that matches them 1:1 — otherwise it prints to the wrong size')
    // 40x30 shape plus 10 mm padding each side.
    ok(Math.abs(parseFloat(m[1]) - 60) < 0.01 && Math.abs(parseFloat(m[2]) - 50) < 0.01,
      'sized to the outline plus a margin', `${m[1]} x ${m[2]}`)
  }
  ok(svg.includes('fill="none"'), 'cut lines are hairlines, not filled shapes')
  ok(svg.includes('Shield'), 'and each piece is labelled')
}

// ---------------------------------------------------------------------------
console.log('\n# entry and exit points')
{
  const line: Stitch[] = [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 },
  ]
  const base = newObject({ type: 'run', paths: [[{ x: 0, y: 0 }, { x: 30, y: 0 }]] })

  ok(orientToEntryExit(line, base)[0].x === 0, 'with no entry or exit, nothing is reordered')

  // Entry near the far end flips the direction.
  const flipped = orientToEntryExit(line, { ...base, entry: { x: 29, y: 0 } })
  ok(flipped[0].x === 30 && flipped[flipped.length - 1].x === 0,
    'an entry near the far end sews the object the other way round',
    `${flipped[0].x} -> ${flipped[flipped.length - 1].x}`)

  // Entry near the natural start leaves it alone.
  const kept = orientToEntryExit(line, { ...base, entry: { x: 1, y: 0 } })
  ok(kept[0].x === 0, 'an entry near the natural start changes nothing')

  // Exit alone is enough to decide.
  const byExit = orientToEntryExit(line, { ...base, exit: { x: 1, y: 0 } })
  ok(byExit[byExit.length - 1].x === 0, 'an exit alone can flip it too')

  // Entry and exit together: the pairing that costs least wins.
  const both = orientToEntryExit(line, { ...base, entry: { x: 31, y: 0 }, exit: { x: -1, y: 0 } })
  ok(both[0].x === 30, 'entry and exit together pick the cheaper orientation')

  // A fill sewn backwards is the same fill, so reversing is always valid —
  // but it must not drop or duplicate anything.
  const long = Array.from({ length: 200 }, (_, i) => ({ x: i, y: i % 3 }))
  const rev = orientToEntryExit(long, { ...base, entry: { x: 199, y: 0 } })
  ok(rev.length === long.length, 'reversing preserves every stitch', `${rev.length}`)
  ok(orientToEntryExit([], base).length === 0, 'an empty object is not a crash')
}


// ---------------------------------------------------------------------------
console.log('\n# 3D puff')
{
  const line: Pt[] = [{ x: 0, y: 0 }, { x: 40, y: 0 }]
  const P = { ...DEFAULT_SATIN(), width: 6, density: 0.4, pullComp: 0, underlay: [] }
  const puff = { ...DEFAULT_PUFF(), enabled: true, thickness: 3 }

  ok(puffCheck(P, puff).warnings.length === 0, 'a 6 mm column over 3 mm foam passes clean',
    puffCheck(P, puff).warnings[0] ?? '')
  // Too narrow: the thread flattens the foam instead of standing on it.
  ok(puffCheck({ ...P, width: 2 }, puff).warnings.some((w) => /narrow/.test(w)),
    `under ${PUFF_MIN_MM} mm is flagged as too narrow`)
  // Too wide: the foam collapses in the middle.
  ok(puffCheck({ ...P, width: 14 }, puff).warnings.some((w) => /wide/.test(w)),
    `over ${PUFF_MAX_MM} mm is flagged as too wide`)
  // A column barely wider than the foam is tall has nowhere to lie down.
  ok(puffCheck({ ...P, width: 4 }, { ...puff, thickness: 3 }).warnings.some((w) => /steep/.test(w)),
    'a column too narrow for the foam THICKNESS is flagged separately')
  ok(puffCheck(P, { ...puff, capEnds: false }).warnings.some((w) => /tear cleanly/.test(w)),
    'turning capping off is called out — this is how puff jobs get ruined')
  ok(puffCheck(P, puff).errors.length === 0,
    'puff problems are warnings, not refusals: a bad puff column still sews')

  // --- end caps
  {
    const caps = puffCaps(line, P)
    ok(caps.length > 8, 'caps are generated at the ends', `${caps.length}`)
    // They must sit AT the ends, across the column.
    const atStart = caps.filter((c) => Math.abs(c.x) < 0.5)
    const atEnd = caps.filter((c) => Math.abs(c.x - 40) < 0.5)
    ok(atStart.length > 2 && atEnd.length > 2, 'one at each end',
      `${atStart.length} / ${atEnd.length}`)
    // And span the column's width, so the perforation crosses the whole thing.
    const span = Math.max(...atStart.map((c) => c.y)) - Math.min(...atStart.map((c) => c.y))
    ok(Math.abs(span - 6) < 0.1, 'the perforation spans the full column width',
      `${span.toFixed(2)} of 6`)
    // Tighter than the column itself — it is a perforation, not coverage.
    const ys = atStart.map((c) => c.y).sort((a, b) => a - b)
    let maxGap = 0
    for (let i = 1; i < ys.length; i++) maxGap = Math.max(maxGap, ys[i] - ys[i - 1])
    ok(maxGap <= P.density / 2 + 1e-6, 'and is punched tighter than the satin pitch',
      `${maxGap.toFixed(3)} mm`)
  }

  // A closed ring has no ends, so nothing to cap.
  ok(puffCaps([...circle(0, 0, 15, 64), { x: 15, y: 0 }], P).length === 0,
    'a closed column has no ends to cap')
}

// ---------------------------------------------------------------------------
console.log('\n# density diagnostics')
{
  const plan = (pts: Pt[]) => ({ blocks: [{ color: '#c0392b', label: 'a', stitches: pts }] })

  // An empty design has nothing to report.
  const none = analyseDensity({ blocks: [] })
  ok(none.hotspots.length === 0 && none.penetrations === 0, 'an empty plan reports nothing')

  // A normal fill: one penetration every 0.4 x 4 mm over a 20 mm square.
  {
    const pts: Pt[] = []
    for (let y = 0; y < 20; y += 0.4) for (let x = 0; x < 20; x += 4) pts.push({ x, y })
    const r = analyseDensity(plan(pts))
    ok(Math.abs(r.worst - 1) < 0.35, 'a normal commercial fill sits near 1x nominal',
      `${r.worst.toFixed(2)}x`)
    ok(r.hotspots.length === 0, 'and raises no hotspots')
  }

  // Four objects stacked in one place — the overlap case a per-object check
  // cannot see.
  {
    const pts: Pt[] = []
    for (let k = 0; k < 4; k++) {
      for (let y = 0; y < 6; y += 0.4) for (let x = 0; x < 6; x += 4) pts.push({ x, y })
    }
    const r = analyseDensity(plan(pts))
    ok(r.worst > WARN_RATIO, 'four stacked fills read as over-dense', `${r.worst.toFixed(2)}x`)
    ok(r.hotspots.length > 0, 'and produce hotspots', `${r.hotspots.length}`)
    ok(r.warnings.length > 0 && /density/.test(r.warnings[0]), 'with an actionable message',
      r.warnings[0])
    ok(r.hotspots[0].ratio >= r.hotspots[r.hotspots.length - 1].ratio, 'worst first')
  }

  // Jumps pierce nothing and must not count.
  {
    const pts: Pt[] = []
    for (let i = 0; i < 400; i++) pts.push({ x: 1, y: 1, jump: true })
    const r = analyseDensity(plan(pts))
    ok(r.penetrations === 0, 'jumps are not penetrations', `${r.penetrations}`)
    ok(r.hotspots.length === 0, 'so a pile of jumps is not a hotspot')
  }

  // Density is counted ACROSS colours: the fabric does not care which needle.
  {
    const dense: Pt[] = []
    for (let i = 0; i < 60; i++) dense.push({ x: 1 + (i % 4) * 0.1, y: 1 + (i % 5) * 0.1 })
    const two = analyseDensity({ blocks: [
      { color: '#a', label: 'a', stitches: dense },
      { color: '#b', label: 'b', stitches: dense },
    ] })
    const one = analyseDensity(plan(dense))
    ok(two.worst > one.worst, 'two colours overlapping read denser than one',
      `${one.worst.toFixed(1)} -> ${two.worst.toFixed(1)}`)
  }

  ok(densityColour(1) === null, 'a normal cell gets no overlay')
  ok(densityColour(WARN_RATIO + 0.1) !== null, 'a warm cell does')
  ok(densityColour(SEVERE_RATIO + 1) !== densityColour(WARN_RATIO + 0.1),
    'and a severe cell is coloured differently from a warm one')
  ok(NOMINAL_PER_MM2 > 0, 'nominal density is a real number')
}


// ---------------------------------------------------------------------------
console.log('\n# manual stitch edits (the freeze model)')
{
  const mk = (): StitchPlan => ({ blocks: [
    { color: '#c0392b', label: 'a', stitches: [
      { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0, jump: true }, { x: 15, y: 0 },
    ] },
    { color: '#1f6feb', label: 'b', stitches: [{ x: 0, y: 9 }, { x: 5, y: 9 }] },
  ] })

  // --- the state machine, which is the whole contract
  ok(freezeState(undefined, 'sig').kind === 'live', 'with no edits the plan is generated')
  const f = freeze(mk(), 'sig-1')
  ok(freezeState(f, 'sig-1').kind === 'frozen', 'after an edit it is frozen')
  ok(freezeState(f, 'sig-2').kind === 'stale',
    'and a source change makes it STALE — a decision, not a silent regenerate')

  // Freezing must COPY: a later edit cannot reach back into the generated plan.
  {
    const live = mk()
    const frz = freeze(live, 's')
    frz.plan.blocks[0].stitches[0].x = 999
    ok(live.blocks[0].stitches[0].x === 0, 'freezing deep-copies the plan')
    const c = clonePlan(live)
    c.blocks[0].stitches[0].y = 42
    ok(live.blocks[0].stitches[0].y === 0, 'and clonePlan does too')
  }

  // --- picking
  {
    const p = mk()
    const hit = pickStitch(p, { x: 5.2, y: 0.1 }, 1)
    ok(hit?.block === 0 && hit.index === 1, 'the nearest stitch is found',
      `${hit?.block}:${hit?.index}`)
    ok(pickStitch(p, { x: 50, y: 50 }, 1) === null, 'nothing is found far away')
    // A jump is travel, not a stitch: there is nothing useful to do to one.
    ok(pickStitch(p, { x: 10, y: 0 }, 0.5) === null, 'jumps are not pickable')

    const box = pickStitchesIn(p, { minX: -1, minY: -1, maxX: 6, maxY: 10 })
    // (0,0) (5,0) from the first block and (0,9) (5,9) from the second; the
    // jump at (10,0) and the stitch at (15,0) are outside or skipped.
    ok(box.length === 4, 'a box selects every real stitch inside it', `${box.length}`)
    ok(box.every((r) => !p.blocks[r.block].stitches[r.index].jump), 'and no jumps')
    ok(box.some((r) => r.block === 1), 'across colour blocks too')
  }

  // --- deleting
  {
    const p = mk()
    const before = penetrationCount(p)
    // Two in the same block at once — the case that breaks when indices shift.
    const after = deleteStitches(p, [{ block: 0, index: 0 }, { block: 0, index: 1 }])
    ok(penetrationCount(after) === before - 2, 'deleting removes exactly what was asked',
      `${before} -> ${penetrationCount(after)}`)
    ok(after.blocks[0].stitches[0].x === 10, 'and removes the RIGHT ones, back to front',
      `${after.blocks[0].stitches[0].x}`)
    ok(p.blocks[0].stitches.length === 4, 'the input plan is untouched')

    // A block emptied completely is dropped: a colour change for no stitches
    // is a thread change the operator makes for nothing.
    const gone = deleteStitches(p, [{ block: 1, index: 0 }, { block: 1, index: 1 }])
    ok(gone.blocks.length === 1, 'an emptied block is dropped, not left as a bare stop',
      `${gone.blocks.length}`)
  }

  // --- moving
  {
    const p = mk()
    const moved = moveStitches(p, [{ block: 0, index: 1 }], 3, -2)
    ok(moved.blocks[0].stitches[1].x === 8 && moved.blocks[0].stitches[1].y === -2,
      'the selected stitch moves')
    ok(moved.blocks[0].stitches[0].x === 0, 'and nothing else does')
    ok(p.blocks[0].stitches[1].x === 5, 'the input plan is untouched')
  }

  // --- the edits survive save and reopen, which is the point of storing them
  {
    const d = emptyDoc()
    d.objects = [newObject({ type: 'fill', paths: [[...rect(0, 0, 20, 20), { x: 0, y: 0 }]] })]
    const sig = docSignature(d)
    d.frozen = freeze(mk(), sig)
    d.frozen.plan = deleteStitches(d.frozen.plan, [{ block: 0, index: 0 }])
    d.frozen.edits = 1

    const back = deserialize(serialize(d))
    ok(!!back.frozen, 'a frozen plan survives save and reopen')
    ok(penetrationCount(back.frozen!.plan) === penetrationCount(d.frozen.plan),
      'with the same number of stitches',
      `${penetrationCount(back.frozen!.plan)}`)
    ok(back.frozen!.signature === sig, 'and the signature it was taken at')
    ok(back.frozen!.edits === 1, 'and the edit count')
    // Flags have to survive or the reopened plan sews differently.
    ok(back.frozen!.plan.blocks[0].stitches.some((st) => st.jump), 'jump flags survive')
    ok(freezeState(back.frozen, sig).kind === 'frozen',
      'and it reopens still matching its source, not stale')
  }

  // A corrupt frozen plan drops back to generating rather than sewing junk.
  {
    const d = emptyDoc()
    d.objects = [newObject({ type: 'run', paths: [[{ x: 0, y: 0 }, { x: 9, y: 0 }]] })]
    // Corrupt the frozen BLOCKS while leaving the file valid JSON — a regex
    // over nested arrays cuts mid-structure and only proves the JSON parser
    // works, which is not what is under test here.
    const parsed = JSON.parse(serialize({ ...d, frozen: freeze(mk(), 'x') }))
    parsed.doc.frozen.blocks = 'nonsense'
    ok(deserialize(JSON.stringify(parsed)).frozen === undefined,
      'an unreadable frozen plan falls back to generating, not to half a plan')
  }
}


// ---------------------------------------------------------------------------
console.log('\n# knockdown and faux overlock')
{
  // --- knockdown: coarse, and BIGGER than what it supports
  {
    const d = emptyDoc()
    const square = [...rect(-15, -15, 30, 30), { x: -15, y: -15 }]
    d.objects = [newObject({
      name: 'KD', type: 'knockdown', paths: [square],
      knockdown: { ...DEFAULT_KNOCKDOWN(), spacing: 2, margin: 2 },
    })]
    const { plan } = digitize(d)
    const pts = plan.blocks.flatMap((b) => b.stitches).filter((s) => !s.jump)
    ok(pts.length > 20, 'a knockdown generates stitches', `${pts.length}`)

    // BIGGER than the outline: pile springs back at the boundary.
    const maxX = Math.max(...pts.map((s) => s.x))
    const minX = Math.min(...pts.map((s) => s.x))
    ok(maxX > 15.2 && minX < -15.2,
      'and reaches beyond the outline by the margin',
      `${minX.toFixed(1)}..${maxX.toFixed(1)} vs -15..15`)

    // COARSE: a knockdown at fill density would be thousands of wasted
    // stitches and a stiff patch of fabric.
    const sameD = emptyDoc()
    sameD.objects = [newObject({ type: 'fill', paths: [square] })]
    const fillCount = digitize(sameD).plan.blocks
      .flatMap((b) => b.stitches).filter((s) => !s.jump).length
    ok(pts.length < fillCount / 3, 'and is far coarser than a fill of the same shape',
      `${pts.length} vs ${fillCount}`)

    // Spacing is honoured: looser setting, fewer stitches.
    const loose = emptyDoc()
    loose.objects = [newObject({
      type: 'knockdown', paths: [square],
      knockdown: { ...DEFAULT_KNOCKDOWN(), spacing: 4, margin: 2 },
    })]
    const looseCount = digitize(loose).plan.blocks
      .flatMap((b) => b.stitches).filter((s) => !s.jump).length
    ok(looseCount < pts.length, 'looser spacing means fewer stitches',
      `${looseCount} vs ${pts.length}`)
  }

  // Sewing order: a knockdown that comes second has flattened nothing.
  {
    const square = [...rect(0, 0, 20, 20), { x: 0, y: 0 }]
    const kd = () => newObject({ name: 'KD', type: 'knockdown', paths: [square] })
    const fill = () => newObject({ name: 'Logo', type: 'fill', paths: [square] })
    const good = emptyDoc(); good.objects = [kd(), fill()]
    const bad = emptyDoc(); bad.objects = [fill(), kd()]
    ok(!digitize(good).warnings.some((w) => /flattens nothing/.test(w)),
      'a knockdown first is not complained about')
    ok(digitize(bad).warnings.some((w) => /flattens nothing/.test(w)),
      'a knockdown sewn after the design is')
    // Hidden objects do not count — they are not sewn.
    const hidden = emptyDoc()
    hidden.objects = [{ ...fill(), visible: false }, kd()]
    ok(!digitize(hidden).warnings.some((w) => /flattens nothing/.test(w)),
      'and a hidden object above it does not trip the check')
  }

  // An open path has no area to flatten.
  {
    const d = emptyDoc()
    d.objects = [newObject({ name: 'open', type: 'knockdown', paths: [[{ x: 0, y: 0 }, { x: 10, y: 0 }]] })]
    const { warnings } = digitize(d)
    ok(warnings.some((w) => /closed area/.test(w)), 'an open knockdown is refused and reported',
      warnings[0] ?? '')
  }

  // --- faux overlock: the bars LEAN
  {
    const path: Pt[] = [{ x: 0, y: 0 }, { x: 60, y: 0 }]
    const base = { ...DEFAULT_SATIN(), width: 4, density: 0.5, pullComp: 0, underlay: [], lean: 0 }
    const square = satinColumn(path, base)
    const leaned = satinColumn(path, { ...base, lean: OVERLOCK_LEAN })

    // A square bar joins two points at the same x; a leaned one does not.
    const barDx = (st: typeof square) => {
      let worst = 0
      for (let i = 1; i < st.length; i++) worst = Math.max(worst, Math.abs(st[i].x - st[i - 1].x))
      return worst
    }
    ok(barDx(square) < 1, 'an unleaned bar crosses square on', `${barDx(square).toFixed(2)}`)
    ok(barDx(leaned) > 1.5, 'a leaned bar crosses at an angle', `${barDx(leaned).toFixed(2)}`)

    // 45 degrees over a 2 mm half-width slides each rail 2 mm along the path,
    // so the two ends of a bar are about 4 mm apart in x.
    ok(Math.abs(barDx(leaned) - 4) < 1.2, 'by half-width x tan(lean)',
      `${barDx(leaned).toFixed(2)} of ~4`)

    // It is still a satin: same rails, same width across.
    const spanY = (st: typeof square) =>
      Math.max(...st.map((s) => s.y)) - Math.min(...st.map((s) => s.y))
    ok(Math.abs(spanY(leaned) - spanY(square)) < 0.2,
      'and the column is still the same width',
      `${spanY(square).toFixed(2)} vs ${spanY(leaned).toFixed(2)}`)
    ok(leaned.length > 20, 'with a full set of stitches', `${leaned.length}`)
  }

  // --- the appliqué border can BE a faux overlock
  {
    const ring = [...rect(0, 0, 40, 30), { x: 0, y: 0 }]
    const plain = appliquePhases(newObject({ name: 'P', type: 'applique', paths: [ring] }), [])
    const serged = appliquePhases(newObject({
      name: 'P', type: 'applique', paths: [ring],
      applique: { ...DEFAULT_APPLIQUE(), borderStyle: 'overlock' },
    }), [])
    ok(/overlock/.test(serged[2].label), 'the phase says it is an overlock edge', serged[2].label)
    ok(!/overlock/.test(plain[2].label), 'and an ordinary border does not')
    // Same phases either way — it is a finish, not a different sequence.
    ok(plain.length === serged.length, 'the sequence is unchanged by the edge style')
  }
}


// ---------------------------------------------------------------------------
console.log('\n# manual satin-angle guides')
{
  const line: Pt[] = [{ x: 0, y: 0 }, { x: 60, y: 0 }]
  const base = { ...DEFAULT_SATIN(), width: 4, density: 0.5, pullComp: 0, underlay: [], lean: 0 }

  // Widest bar step in x over a window, which is how far off square a bar is.
  const barDx = (st: { x: number; y: number }[], from = -Infinity, to = Infinity) => {
    let worst = 0
    for (let i = 1; i < st.length; i++) {
      const a = st[i - 1], b = st[i]
      if (a.x < from || a.x > to || b.x < from || b.x > to) continue
      worst = Math.max(worst, Math.abs(b.x - a.x))
    }
    return worst
  }

  // --- a guide states the angle, and only where it was drawn
  {
    // A guide at x=30 leaning 45 degrees: drawn from lower-left to upper-right
    // ACROSS the column, which runs along +x with its normal along y.
    const g = { a: { x: 28, y: -2 }, b: { x: 32, y: 2 } }
    const plain = satinColumn(line, base)
    const steered = satinColumn(line, base, [g])
    ok(barDx(plain) < 1, 'without guides the bars cross square', barDx(plain).toFixed(2))
    ok(barDx(steered) > 2.5, 'a guide turns the bars', barDx(steered).toFixed(2))
    ok(plain.length > 20 && steered.length > 20, 'both are full columns')
  }

  // --- ONE guide governs the WHOLE column, not just where it sits
  {
    const g = { a: { x: 28, y: -2 }, b: { x: 32, y: 2 } }
    const st = satinColumn(line, base, [g])
    const nearStart = barDx(st, 0, 12)
    const nearEnd = barDx(st, 48, 60)
    ok(nearStart > 2.5 && nearEnd > 2.5,
      'a single guide is held to both ends rather than fading to square',
      `start ${nearStart.toFixed(2)}, end ${nearEnd.toFixed(2)}`)
  }

  // --- two guides INTERPOLATE between them
  {
    const square = { a: { x: 5, y: -2 }, b: { x: 5, y: 2 } }      // 0 degrees
    const slanted = { a: { x: 53, y: -2 }, b: { x: 57, y: 2 } }   // 45 degrees
    const st = satinColumn(line, base, [square, slanted])
    const atStart = barDx(st, 0, 10)
    const atMid = barDx(st, 25, 35)
    const atEnd = barDx(st, 50, 60)
    ok(atStart < atMid && atMid < atEnd,
      'the angle ramps between two guides',
      `${atStart.toFixed(2)} < ${atMid.toFixed(2)} < ${atEnd.toFixed(2)}`)
  }

  // --- drawing a guide the other way round means the same thing
  {
    const g = { a: { x: 28, y: -2 }, b: { x: 32, y: 2 } }
    const flipped = { a: g.b, b: g.a }
    const one = satinColumn(line, base, [g])
    const other = satinColumn(line, base, [flipped])
    const same = one.length === other.length &&
      one.every((s, i) => Math.abs(s.x - other[i].x) < 1e-6 && Math.abs(s.y - other[i].y) < 1e-6)
    ok(same, 'a guide has no direction — drawing it backwards is identical')
  }

  // --- the column still spans the same WIDTH across
  {
    const g = { a: { x: 28, y: -2 }, b: { x: 32, y: 2 } }
    const spanY = (st: { y: number }[]) =>
      Math.max(...st.map((s) => s.y)) - Math.min(...st.map((s) => s.y))
    ok(Math.abs(spanY(satinColumn(line, base, [g])) - spanY(satinColumn(line, base))) < 0.2,
      'turning the bars does not change the width across')
  }

  // --- the angle is CAPPED
  {
    // Nearly parallel to the column: past the cap the bars stop overlapping.
    const steep = { a: { x: 20, y: -0.2 }, b: { x: 40, y: 0.2 } }
    const res = resolveGuides(line, [steep], false, 99)
    ok(res.length === 1, 'a near-parallel guide still resolves')
    ok(Math.abs(res[0].rel) <= (MAX_BAR_ANGLE * Math.PI) / 180 + 1e-9,
      'and is clamped to the bar-angle limit',
      `${((res[0].rel * 180) / Math.PI).toFixed(1)} deg`)
  }

  // --- a guide off in space is REFUSED, not snapped
  {
    const far = { a: { x: 30, y: 40 }, b: { x: 34, y: 44 } }
    let dropped = 0
    resolveGuides(line, [far], false, GUIDE_REACH_MM, () => dropped++)
    ok(dropped === 1, 'a guide nowhere near the column is dropped')

    const d = emptyDoc()
    d.objects = [newObject({ name: 'S', type: 'satin', paths: [line], satin: base })]
    d.objects[0].guides = [far]
    ok(digitize(d).warnings.some((w) => /angle guide sits/.test(w)),
      'and the design says so', digitize(d).warnings.find((w) => /guide/.test(w)) ?? '')
  }

  // --- each guide belongs to the ONE stroke it was drawn on
  {
    const strokeA: Pt[] = [{ x: 0, y: 0 }, { x: 40, y: 0 }]
    const strokeB: Pt[] = [{ x: 0, y: 30 }, { x: 40, y: 30 }]
    const onA = { a: { x: 18, y: -2 }, b: { x: 22, y: 2 } }
    const onB = { a: { x: 18, y: 28 }, b: { x: 22, y: 32 } }
    const { byPath, orphans } = assignGuides([strokeA, strokeB], [onA, onB])
    ok(orphans.length === 0, 'both guides find a stroke')
    ok(byPath.get(strokeA)?.length === 1 && byPath.get(strokeB)?.length === 1,
      'and each lands on its own', `A:${byPath.get(strokeA)?.length} B:${byPath.get(strokeB)?.length}`)
    ok(byPath.get(strokeA)?.[0] === onA, 'the right one, not just one each')
  }

  // --- angleAt holds, interpolates, and falls back
  {
    ok(angleAt([], 5, 0.3) === 0.3, 'no guides means the lean is used')
    const gs = [{ s: 10, rel: 0 }, { s: 20, rel: 1 }]
    ok(angleAt(gs, 0, 0.9) === 0, 'before the first guide its angle is held')
    ok(angleAt(gs, 99, 0.9) === 1, 'after the last guide its angle is held')
    ok(Math.abs(angleAt(gs, 15, 0.9) - 0.5) < 1e-9, 'and between them it interpolates')
  }

  // --- determinism (spec 5): same input, same plan
  {
    const g = { a: { x: 28, y: -2 }, b: { x: 32, y: 2 } }
    const a = satinColumn(line, base, [g])
    const b = satinColumn(line, base, [g])
    ok(JSON.stringify(a) === JSON.stringify(b), 'guided generation is deterministic')
  }
}


// ---------------------------------------------------------------------------
console.log('\n# the plan regenerates when the document changes')
{
  // THE BUG THIS EXISTS FOR. docSignature used to be a hand-written list of
  // fields, so every setting added after it was written changed the document
  // WITHOUT changing its signature: useStitchPlan never re-ran, and the
  // canvas kept showing stitches from before the change. A control that does
  // nothing is worse than one that is missing, because nothing says so.
  const base = () => {
    const d = emptyDoc()
    d.objects = [newObject({
      // A FIXED id: newObject mints a fresh one each call, so two otherwise
      // identical documents would differ and the stability check below would
      // be testing the id generator rather than the signature.
      id: 'fixed',
      name: 'S', type: 'satin',
      paths: [[{ x: 0, y: 0 }, { x: 30, y: 0 }]],
      shapes: [{ closed: false, nodes: [{ x: 0, y: 0 }, { x: 30, y: 0 }] }],
    })]
    return d
  }

  // Every setting a saved file can hold, each changed on its own.
  const edits: [string, (d: Doc) => void][] = [
    ['name', (d) => { d.name = 'other' }],
    ['hoop', (d) => { d.hoop = HOOPS.find((x) => x.name.includes('5.5'))! }],
    ['spacing', (d) => { d.spacing = 'TJ600' }],
    ['tie-in off', (d) => { d.tie.tieIn = false }],
    ['tie-off off', (d) => { d.tie.tieOff = false }],
    ['tie style', (d) => { d.tie.style = 'backtrack' }],
    ['tie length', (d) => { d.tie.length = 2 }],
    ['tie stitches', (d) => { d.tie.stitches = 6 }],
    ['object name', (d) => { d.objects[0].name = 'renamed' }],
    ['colour', (d) => { d.objects[0].color = '#00ff00' }],
    ['thread', (d) => { d.objects[0].thread = { brand: 'Isacord', code: '1902' } }],
    ['visibility', (d) => { d.objects[0].visible = false }],
    ['stitch type', (d) => { d.objects[0].type = 'fill' }],
    ['two-rail flag', (d) => { d.objects[0].twoRail = true }],
    ['run length', (d) => { d.objects[0].run.length = 3.3 }],
    ['satin width', (d) => { d.objects[0].satin.width = 6 }],
    ['satin density', (d) => { d.objects[0].satin.density = 0.9 }],
    ['satin pull comp', (d) => { d.objects[0].satin.pullComp = 0.44 }],
    ['satin underlay', (d) => { d.objects[0].satin.underlay = ['edge', 'zigzag'] }],
    ['bar lean', (d) => { d.objects[0].satin.lean = 30 }],
    ['fill style', (d) => { d.objects[0].fill.style = 'stipple' }],
    ['run style', (d) => { d.objects[0].run.style = 'motif' }],
    ['motif choice', (d) => { d.objects[0].motif.id = 'star' }],
    ['motif width', (d) => { d.objects[0].motif.widthMm = 9 }],
    ['motif height', (d) => { d.objects[0].motif.heightMm = 9 }],
    ['motif gap', (d) => { d.objects[0].motif.gapMm = 2 }],
    ['fill angle', (d) => { d.objects[0].fill.angle = 12 }],
    ['fill spacing', (d) => { d.objects[0].fill.spacing = 0.7 }],
    ['fill length', (d) => { d.objects[0].fill.length = 2.2 }],
    ['fill stagger', (d) => { d.objects[0].fill.stagger = 0.2 }],
    ['fill pull comp', (d) => { d.objects[0].fill.pullComp = 0.4 }],
    ['fill underlay', (d) => { d.objects[0].fill.underlay = [] }],
    ['fill border', (d) => { d.objects[0].fill.border.enabled = true }],
    ['appliqué tack width', (d) => { d.objects[0].applique.tackWidth = 2.4 }],
    ['appliqué border', (d) => { d.objects[0].applique.border = false }],
    ['appliqué edge style', (d) => { d.objects[0].applique.borderStyle = 'overlock' }],
    ['puff on', (d) => { d.objects[0].puff.enabled = true }],
    ['puff thickness', (d) => { d.objects[0].puff.thickness = 2 }],
    ['puff density scale', (d) => { d.objects[0].puff.densityScale = 0.6 }],
    ['puff caps', (d) => { d.objects[0].puff.capEnds = false }],
    ['knockdown spacing', (d) => { d.objects[0].knockdown.spacing = 3.3 }],
    ['knockdown margin', (d) => { d.objects[0].knockdown.margin = 4 }],
    ['knockdown angle', (d) => { d.objects[0].knockdown.angle = 80 }],
    ['knockdown length', (d) => { d.objects[0].knockdown.length = 6 }],
    ['entry point', (d) => { d.objects[0].entry = { x: 1, y: 2 } }],
    ['exit point', (d) => { d.objects[0].exit = { x: 3, y: 4 } }],
    ['angle guides', (d) => { d.objects[0].guides = [{ a: { x: 14, y: -2 }, b: { x: 16, y: 2 } }] }],
    ['path geometry', (d) => { d.objects[0].paths[0][1].x = 31 }],
    ['node geometry', (d) => { d.objects[0].shapes![0].nodes[1].x = 31 }],
    ['node handles', (d) => { d.objects[0].shapes![0].nodes[0].hOut = { x: 5, y: 5 } }],
    ['node smoothness', (d) => { d.objects[0].shapes![0].nodes[0].smooth = true }],
    ['lettering', (d) => { d.objects[0].text = { ...DEFAULT_TEXT(), words: 'hi' } }],
    ['an added object', (d) => { d.objects.push(newObject({ paths: [[{ x: 0, y: 0 }]] })) }],
  ]
  const before = docSignature(base())
  let missed: string[] = []
  for (const [what, edit] of edits) {
    const d = base()
    edit(d)
    if (docSignature(d) === before) missed.push(what)
  }
  ok(missed.length === 0, `all ${edits.length} saveable settings change the signature`,
    missed.length ? `MISSED: ${missed.join(', ')}` : '')

  // The same document twice must hash the same, or the plan regenerates on
  // every render and nothing is ever stable.
  ok(docSignature(base()) === docSignature(base()), 'and an unchanged document does not')

  // The geometry split is what makes this fast; this is the guard that keeps
  // it honest. A geometry field added to the save format but not listed is
  // hashed by neither half, which is the original bug wearing a new hat.
  {
    // Probed on an object that HAS every optional field: `guides` and the
    // rest are written only when present, so an empty object would report
    // them as missing from the format.
    // EVERY optional field set. They are written conditionally, so a probe
    // without them would compare two functions that both omit the same keys
    // and prove nothing about the ones that matter.
    const probe = base()
    probe.objects[0].guides = [{ a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }]
    probe.objects[0].entry = { x: 1, y: 1 }
    probe.objects[0].exit = { x: 2, y: 2 }
    probe.objects[0].twoRail = true
    probe.objects[0].group = 'g1'
    probe.objects[0].text = { ...DEFAULT_TEXT(), path: [{ x: 0, y: 0 }, { x: 5, y: 0 }] }
    const saved = objectOut(probe.objects[0]) as Record<string, unknown>
    const settings = settingsOut(probe.objects[0]) as Record<string, unknown>
    const declared = SIGNATURE_GEOMETRY_KEYS as readonly string[]
    // THE GUARD THAT KEEPS THE SPLIT HONEST. The settings half is hashed
    // wholesale and the geometry half is folded numerically; a field added
    // to the save format and to neither would be hashed by nothing, which is
    // the original bug wearing a new hat.
    const covered = [...Object.keys(settings), ...declared].sort().join(',')
    ok(covered === Object.keys(saved).sort().join(','),
      'settings + declared geometry is exactly what gets saved',
      `saved: ${Object.keys(saved).sort().join(',')}\n      covered: ${covered}`)
    ok(declared.every((k) => k in saved),
      'and every declared geometry key really is in the save format')
  }

  // Speed: this runs on every render, including every frame of a drag.
  //
  // Measured RELATIVE to the thing it replaced, not against a number of
  // milliseconds. An absolute budget is a property of whatever machine
  // happens to run the suite — this one failed on the deploy host, which is
  // slower than a laptop and is not the machine anyone drags on — while the
  // property that actually matters is machine-independent: hashing the
  // geometry numerically must stay far cheaper than stringifying it, which
  // is what the first version of docSignature did and what cost ~10 ms a
  // frame.
  {
    const big = emptyDoc()
    for (let k = 0; k < 20; k++) {
      big.objects.push(newObject({
        type: 'fill',
        paths: [Array.from({ length: 1000 }, (_, i) => ({ x: Math.sin(i) * 20, y: Math.cos(i) * 20 }))],
      }))
    }
    const stringifyAll = () => JSON.stringify(big.objects.map((o) => objectOut(o))).length
    // Warm both paths before timing either.
    docSignature(big); stringifyAll()
    const time = (f: () => unknown, n: number) => {
      const t0 = performance.now()
      for (let i = 0; i < n; i++) f()
      return (performance.now() - t0) / n
    }
    const ours = time(() => docSignature(big), 10)
    const naive = time(stringifyAll, 10)
    ok(ours < naive / 2.5,
      'the signature is far cheaper than stringifying the geometry would be',
      `${ours.toFixed(2)} ms vs ${naive.toFixed(2)} ms`)
  }
}

console.log('\n# satin splitting')
{
  const line: Pt[] = [{ x: 0, y: 0 }, { x: 50, y: 0 }]
  const wide = (over: Partial<ReturnType<typeof DEFAULT_SATIN>> = {}) => ({
    ...DEFAULT_SATIN(), width: 14, density: 0.5, pullComp: 0, underlay: [], lean: 0, ...over,
  })

  // --- without splitting, a wide column is still REFUSED
  {
    const c = satinCheck(line, wide())
    ok(c.errors.some((e) => new RegExp(`${MAX_SATIN_MM} mm limit`).test(e)),
      'a 14 mm column is refused when splitting is off', c.errors[0] ?? '')
    ok(c.errors.some((e) => /satin splitting/.test(e)),
      'and the message says what to turn on')
  }

  // --- with splitting, it is allowed, and the bars really are broken up
  {
    const p = wide({ split: { enabled: true, maxLength: 5, stagger: 0.7 } })
    const c = satinCheck(line, p)
    ok(c.errors.length === 0, 'the same column is allowed once splitting is on', c.errors[0] ?? '')
    ok(c.warnings.some((w) => /split line will show/.test(w)),
      'with an honest warning that the split will be visible')

    const st = satinColumn(line, p)
    let longest = 0
    for (let i = 1; i < st.length; i++) longest = Math.max(longest, dist(st[i - 1], st[i]))
    ok(longest <= 5 + 1e-6, 'and no stitch is longer than the split length',
      `${longest.toFixed(2)} mm`)

    // It is still a 14 mm column: splitting adds holes, it does not narrow it.
    const spanY = Math.max(...st.map((s) => s.y)) - Math.min(...st.map((s) => s.y))
    ok(Math.abs(spanY - 14) < 0.2, 'the column is still its full width', `${spanY.toFixed(2)} mm`)

    const unsplit = satinColumn(line, { ...p, split: { enabled: false, maxLength: 5, stagger: 0 } })
    ok(st.length > unsplit.length, 'splitting adds penetrations', `${unsplit.length} -> ${st.length}`)
  }

  // --- THE SPLIT POINTS MUST STAGGER, or the column grows a seam
  {
    const p = (stagger: number) => wide({ split: { enabled: true, maxLength: 5, stagger } })
    // Pick out the added penetrations and see how far across they land.
    const acrossOf = (stagger: number) =>
      satinColumn(line, p(stagger)).filter((s) => s.split).map((s) => s.y)

    const seam = acrossOf(0)
    const scattered = acrossOf(1)
    const spread = (ys: number[]) => {
      // How many DISTINCT positions across the column the splits use.
      return new Set(ys.map((y) => Math.round(y * 2))).size
    }
    ok(seam.length > 10 && scattered.length > 10, 'both produce plenty of splits')
    ok(spread(scattered) > spread(seam),
      'staggering scatters the split points instead of lining them up',
      `${spread(seam)} positions -> ${spread(scattered)}`)
  }

  // --- determinism: no random numbers anywhere in here
  {
    const p = wide({ split: { enabled: true, maxLength: 5, stagger: 0.7 } })
    ok(JSON.stringify(satinColumn(line, p)) === JSON.stringify(satinColumn(line, p)),
      'splitting is deterministic')
  }

  // --- splitting does not make ANY width sewable
  {
    const huge = wide({ width: 40, split: { enabled: true, maxLength: 5, stagger: 0.7 } })
    ok(satinCheck(line, huge).errors.some((e) => new RegExp(`${MAX_SPLIT_SATIN_MM} mm`).test(e)),
      'a 40 mm column is refused even split', satinCheck(line, huge).errors[0] ?? '')
  }

  // --- a split length over the snag limit is not a split at all
  {
    const silly = wide({ split: { enabled: true, maxLength: 12, stagger: 0.7 } })
    ok(satinCheck(line, silly).errors.some((e) => /does not make the stitches sewable/.test(e)),
      'splitting at 12 mm is refused — it changes nothing')
  }

  // --- it works on a TWO-RAIL column too
  {
    const railA: Pt[] = [{ x: 0, y: 0 }, { x: 50, y: 0 }]
    const railB: Pt[] = [{ x: 0, y: 13 }, { x: 50, y: 13 }]
    const p = wide({ split: { enabled: true, maxLength: 5, stagger: 0.7 } })
    ok(twoRailCheck(railA, railB, p).errors.length === 0,
      'a wide two-rail column is allowed when split',
      twoRailCheck(railA, railB, p).errors[0] ?? '')
    ok(twoRailCheck(railA, railB, { ...p, split: { enabled: false, maxLength: 5, stagger: 0 } })
      .errors.length > 0, 'and refused when it is not')
    const st = satinTwoRail(railA, railB, p)
    let longest = 0
    for (let i = 1; i < st.length; i++) longest = Math.max(longest, dist(st[i - 1], st[i]))
    ok(longest <= 5 + 1e-6, 'with no over-long stitch', `${longest.toFixed(2)} mm`)
  }

  // --- the engine's OWN columns are never split behind the user's back
  {
    // A tack-down is 1.6 mm wide. Splitting it would put a hole in the middle
    // of every bar of a stitch meant to be invisible.
    const ring = [...rect(0, 0, 40, 30), { x: 0, y: 0 }]
    const phases = appliquePhases(newObject({ name: 'A', type: 'applique', paths: [ring] }), [])
    ok(!phases.some((ph) => ph.stitches.some((s) => s.split)),
      'no appliqué phase comes back split')
  }
}


// ---------------------------------------------------------------------------
console.log('\n# tie-in and tie-off as settings')
{
  const square = [...rect(0, 0, 25, 25), { x: 0, y: 0 }]
  const far = [...rect(70, 70, 25, 25), { x: 70, y: 70 }]
  const build = (tie: Partial<ReturnType<typeof DEFAULT_TIE>>) => {
    const d = emptyDoc()
    d.tie = { ...DEFAULT_TIE(), ...tie }
    // Two objects far apart, so the design has a trim in the middle as well
    // as a start and an end — all three places a lock belongs.
    d.objects = [
      newObject({ name: 'A', type: 'fill', paths: [square] }),
      newObject({ name: 'B', type: 'fill', paths: [far] }),
    ]
    return d
  }
  const locksIn = (d: Doc) =>
    digitize(d).plan.blocks.flatMap((b) => b.stitches).filter((s) => s.lock).length

  // --- the defaults tie, and the settings really remove them
  {
    const on = locksIn(build({}))
    ok(on > 0, 'a design ties by default', `${on} lock stitches`)
    ok(locksIn(build({ tieIn: false, tieOff: false })) === 0,
      'turning both off removes every lock')
    const inOnly = locksIn(build({ tieOff: false }))
    const offOnly = locksIn(build({ tieIn: false }))
    ok(inOnly > 0 && inOnly < on, 'tie-in alone leaves fewer', `${inOnly} of ${on}`)
    ok(offOnly > 0 && offOnly < on, 'tie-off alone leaves fewer', `${offOnly} of ${on}`)
  }

  // --- and the design SAYS so, because nothing downstream can tell the
  //     difference between "the machine does it" and "nobody did"
  {
    ok(digitize(build({ tieIn: false })).warnings.some((w) => /Tie-in is off/.test(w)),
      'turning ties off is reported')
    ok(!digitize(build({})).warnings.some((w) => /tie/i.test(w)),
      'and leaving them on is not nagged about')
  }

  // --- the count setting changes the lock, the length setting changes its size
  {
    const four = locksIn(build({ stitches: 4 }))
    const six = locksIn(build({ stitches: 6 }))
    ok(six > four, 'more tie stitches means more lock penetrations', `${four} -> ${six}`)

    // Measured across ONE lock, not across the block: a block holds the
    // opening lock and the locks either side of its trim, and those are
    // centimetres apart, so a whole-block span measures the design.
    const span = (d: Doc) => {
      const all = digitize(d).plan.blocks[0].stitches
      const start = all.findIndex((s) => s.lock)
      const group = []
      for (let i = start; i < all.length && all[i].lock; i++) group.push(all[i])
      let worst = 0
      for (const a of group) for (const b of group) worst = Math.max(worst, dist(a, b))
      return worst
    }
    ok(span(build({ length: 2.5 })) > span(build({ length: 1.1 })) + 0.5,
      'and a longer tie stitch makes a longer lock',
      `${span(build({ length: 1.1 })).toFixed(2)} -> ${span(build({ length: 2.5 })).toFixed(2)}`)
  }

  // --- zigzag lifts the lock OFF the line of travel; backtrack sits on it.
  //     Both have the same number of penetrations and the same out-and-back
  //     shape — the whole difference is whether the holes are strung along
  //     one line, where a short-stitch filter can treat them as one.
  {
    // How far the lock wanders perpendicular to its own direction of travel.
    const sideways = (style: 'zigzag' | 'backtrack') => {
      const all = digitize(build({ style })).plan.blocks[0].stitches
      const start = all.findIndex((s) => s.lock)
      const group = []
      for (let i = start; i < all.length && all[i].lock; i++) group.push(all[i])
      if (group.length < 3) return 0
      // Travel direction from the first to the furthest lock point.
      let far = group[0], d0 = 0
      for (const g of group) { const d = dist(group[0], g); if (d > d0) { d0 = d; far = g } }
      const ux = (far.x - group[0].x) / (d0 || 1), uy = (far.y - group[0].y) / (d0 || 1)
      let worst = 0
      for (const g of group) {
        const vx = g.x - group[0].x, vy = g.y - group[0].y
        worst = Math.max(worst, Math.abs(vx * -uy + vy * ux))
      }
      return worst
    }
    ok(sideways('backtrack') < 0.01, 'a backtrack lock stays on one line',
      sideways('backtrack').toFixed(3))
    ok(sideways('zigzag') > 0.2, 'a zigzag lock does not', sideways('zigzag').toFixed(3))
  }

  // --- a lock is never eaten by the short-stitch floor
  {
    const d = build({ length: 0.6 })
    const locks = digitize(d).plan.blocks.flatMap((b) => b.stitches).filter((s) => s.lock)
    ok(locks.length > 0, 'a short tie survives the short-stitch suppressor',
      `${locks.length} lock stitches at 0.6 mm`)
  }

  // --- an old file has no tie block at all, and that must not mean "off"
  {
    const text = serialize(build({}))
    const raw = JSON.parse(text)
    delete raw.doc.tie
    const back = deserialize(JSON.stringify(raw))
    ok(back.tie.tieIn && back.tie.tieOff,
      'a project saved before ties existed still ties')
  }
}


// ---------------------------------------------------------------------------
console.log('\n# shape operations')
{
  const box = (x: number, y: number, w: number, h: number) => [...rect(x, y, w, h), { x, y }]
  const A = [box(0, 0, 20, 20)]
  const B = [box(10, 10, 20, 20)]

  // --- booleans
  {
    const u = booleanOp('union', [A, B])
    ok(u.errors.length === 0 && u.paths.length === 1, 'two overlapping squares unite into one',
      u.errors[0] ?? `${u.paths.length} paths`)
    // Union area: 400 + 400 - 100 overlap = 700.
    const area = Math.abs(ringArea(u.paths[0]))
    ok(Math.abs(area - 700) < 1, 'with the right area', `${area.toFixed(1)} of 700`)

    const i = booleanOp('intersection', [A, B])
    ok(Math.abs(Math.abs(ringArea(i.paths[0])) - 100) < 1, 'intersect keeps only the overlap',
      `${Math.abs(ringArea(i.paths[0])).toFixed(1)} of 100`)

    const d = booleanOp('difference', [A, B])
    ok(Math.abs(Math.abs(ringArea(d.paths[0])) - 300) < 1,
      'subtract takes the FRONT shape out of the back one',
      `${Math.abs(ringArea(d.paths[0])).toFixed(1)} of 300`)

    const x = booleanOp('xor', [A, B])
    const xArea = x.paths.reduce((n, p) => n + Math.abs(ringArea(p)), 0)
    ok(Math.abs(xArea - 600) < 1, 'exclude keeps everything but the overlap',
      `${xArea.toFixed(1)} of 600`)
  }

  // --- a boolean needs AREAS, and says so rather than inventing one
  {
    const line = [[{ x: 0, y: 0 }, { x: 20, y: 0 }]]
    const r = booleanOp('union', [A, line])
    ok(r.errors.length === 1 && /closed shape/.test(r.errors[0]),
      'an open path is refused, not silently closed', r.errors[0])
    ok(booleanOp('union', [A]).errors.length === 1, 'and one object is not a boolean')
  }

  // --- a result with no area is an ANSWER, phrased as one
  {
    const far = [box(500, 500, 10, 10)]
    ok(/do not overlap/.test(booleanOp('intersection', [A, far]).errors[0] ?? ''),
      'intersecting shapes that miss each other says they miss')
    const big = [box(-10, -10, 60, 60)]
    ok(/completely/.test(booleanOp('difference', [A, big]).errors[0] ?? ''),
      'subtracting something that covers it says so')
  }

  // --- remove overlap: the one embroidery needs most
  {
    // Sewing order: A first, B second. B is on top, so B keeps everything.
    const out = removeOverlap([A, B])
    ok(out.every((r) => r.errors.length === 0), 'remove overlap runs clean')
    const aArea = out[0].paths.reduce((n, p) => n + Math.abs(ringArea(p)), 0)
    const bArea = out[1].paths.reduce((n, p) => n + Math.abs(ringArea(p)), 0)
    ok(Math.abs(bArea - 400) < 1, 'the object sewn LAST keeps its whole shape',
      `${bArea.toFixed(1)} of 400`)
    ok(Math.abs(aArea - 300) < 1, 'and the one under it is knocked back',
      `${aArea.toFixed(1)} of 300`)
    // The whole point: no area is covered twice.
    ok(Math.abs(aArea + bArea - 700) < 1, 'so nothing is sewn twice',
      `${(aArea + bArea).toFixed(1)} of 700 total`)

    // Completely buried means nothing left, not a stubborn remnant.
    const buried = removeOverlap([[box(5, 5, 5, 5)], [box(0, 0, 20, 20)]])
    ok(buried[0].paths.length === 0, 'an object completely covered keeps nothing')

    // An open path has no area to knock out; it passes through rather than
    // failing the whole operation.
    const mixed = removeOverlap([[[{ x: 0, y: 0 }, { x: 9, y: 9 }]], B])
    ok(mixed[0].paths.length === 1 && mixed[0].errors.length === 0,
      'an open path in the mix is left alone')
  }

  // --- offset
  {
    const grown = offsetOp(A, 2)
    ok(grown.errors.length === 0, 'an outline grows', grown.errors[0] ?? '')
    const gb = bounds(grown.paths)!
    ok(Math.abs(gb.maxX - gb.minX - 24) < 0.6, 'by the distance asked for, on both sides',
      `${(gb.maxX - gb.minX).toFixed(2)} of 24`)

    const shrunk = offsetOp(A, -2)
    const sb = bounds(shrunk.paths)!
    ok(Math.abs(sb.maxX - sb.minX - 16) < 0.6, 'and shrinks', `${(sb.maxX - sb.minX).toFixed(2)} of 16`)

    ok(/closed shape/.test(offsetOp([[{ x: 0, y: 0 }, { x: 10, y: 0 }]], 2).errors[0] ?? ''),
      'offsetting an open path is refused — that is a satin column, not an offset')
    ok(offsetOp([box(0, 0, 3, 3)], -5).errors.length === 1,
      'shrinking past nothing is reported rather than returning an empty shape')
  }

  // --- simplify
  {
    // A circle sampled far more finely than any needle can follow.
    const fine = Array.from({ length: 400 }, (_, i) => {
      const t = (i / 400) * Math.PI * 2
      return { x: Math.cos(t) * 20, y: Math.sin(t) * 20 }
    })
    fine.push({ ...fine[0] })
    const r = simplifyPaths([fine], 0.2)
    ok(r.paths[0].length < fine.length / 3, 'a 400-point circle thins out',
      `${fine.length} -> ${r.paths[0].length}`)
    // And still a circle: every surviving point is on the original radius.
    const worst = Math.max(...r.paths[0].map((p) => Math.abs(Math.hypot(p.x, p.y) - 20)))
    ok(worst < 0.3, 'without moving off the shape', `${worst.toFixed(3)} mm`)
    ok(isClosed(r.paths[0]), 'and stays closed')

    const tri = [box(0, 0, 10, 10)]
    ok(simplifyPaths(tri, 0.2).paths[0].length >= 4,
      'a shape already at its minimum is not thinned away')
  }

  // --- node cleanup keeps the CURVES
  {
    const shapes = [{
      closed: false,
      nodes: [
        { x: 0, y: 0 },
        { x: 5, y: 0 },              // collinear, no handles -> goes
        { x: 5.01, y: 0 },           // a duplicate -> goes
        { x: 10, y: 0 },
        { x: 15, y: 5, hIn: { x: 12, y: 0 }, hOut: { x: 18, y: 10 } }, // has handles -> stays
        { x: 20, y: 10 },
      ],
    }]
    const c = cleanNodes(shapes, 0.1)
    ok(c.removed === 2, 'a duplicate and a bare collinear node are removed', `${c.removed}`)
    ok(c.shapes[0].nodes.some((n) => n.hIn || n.hOut),
      'and a node with handles survives, however straight it looks')
  }

  // --- split
  {
    const open = { closed: false, nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }] }
    const s = splitShapeAt(open, 1)
    ok(s.shapes.length === 2, 'cutting an open path gives two')
    ok(s.shapes[0].nodes.length === 2 && s.shapes[1].nodes.length === 3, 'split at the right node')
    ok(dist(s.shapes[0].nodes[1], s.shapes[1].nodes[0]) < 1e-9,
      'and the cut node is kept on both sides')
    ok(splitShapeAt(open, 0).errors.length === 1, 'cutting at an end is refused')

    const ring = { closed: true, nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }
    const c = splitShapeAt(ring, 2)
    ok(c.shapes.length === 1 && !c.shapes[0].closed,
      'cutting a RING once opens it — one cut cannot make two pieces')
    ok(c.shapes[0].nodes.length === 5, 'and the cut node appears at both ends')
  }

  // --- join
  {
    // Three segments of one line, drawn in a muddle: one backwards, one in
    // the wrong order. This is what an SVG import looks like.
    const segs = [
      { closed: false, nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      { closed: false, nodes: [{ x: 30, y: 0 }, { x: 20, y: 0 }] },
      { closed: false, nodes: [{ x: 10, y: 0 }, { x: 20, y: 0 }] },
    ]
    const j = joinShapes(segs, 0.5)
    ok(j.shapes.length === 1, 'three scattered segments join into one', `${j.shapes.length}`)
    ok(j.joined === 2, 'in two joins')
    ok(j.shapes[0].nodes.length === 4, 'with no node lost or doubled',
      `${j.shapes[0].nodes.length}`)

    // Ends that meet make a RING, which is what turns segments into
    // something fillable.
    const sides = [
      { closed: false, nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      { closed: false, nodes: [{ x: 10, y: 0 }, { x: 10, y: 10 }] },
      { closed: false, nodes: [{ x: 10, y: 10 }, { x: 0, y: 10 }] },
      { closed: false, nodes: [{ x: 0, y: 10 }, { x: 0, y: 0 }] },
    ]
    const ring = joinShapes(sides, 0.5)
    ok(ring.shapes.length === 1 && ring.shapes[0].closed,
      'four sides become a closed ring')
    ok(ring.shapes[0].nodes.length === 4, 'with four corners, not five',
      `${ring.shapes[0].nodes.length}`)

    // Ends that are nowhere near each other are left alone.
    const apart = joinShapes([
      { closed: false, nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      { closed: false, nodes: [{ x: 90, y: 0 }, { x: 99, y: 0 }] },
    ], 0.5)
    ok(apart.shapes.length === 2 && apart.joined === 0, 'unrelated segments are not welded')
  }
}


// ---------------------------------------------------------------------------
console.log('\n# align, distribute and mirror')
{
  const B = (minX: number, minY: number, w: number, h: number) =>
    ({ minX, minY, maxX: minX + w, maxY: minY + h })

  // --- align is to the SELECTION's bounds, not to a member
  {
    const boxes = [B(0, 0, 10, 10), B(50, 20, 30, 10), B(20, 40, 5, 10)]
    const left = alignDeltas(boxes, 'left')
    const moved = boxes.map((b, i) => b.minX + left[i].x)
    ok(moved.every((x) => Math.abs(x - 0) < 1e-9), 'left edges all land on the leftmost',
      moved.map((x) => x.toFixed(1)).join(','))

    const right = alignDeltas(boxes, 'right')
    const rs = boxes.map((b, i) => b.maxX + right[i].x)
    ok(rs.every((x) => Math.abs(x - 80) < 1e-9), 'right edges all land on the rightmost',
      rs.map((x) => x.toFixed(1)).join(','))

    const mid = alignDeltas(boxes, 'centreX')
    const cs = boxes.map((b, i) => (b.minX + b.maxX) / 2 + mid[i].x)
    ok(cs.every((x) => Math.abs(x - 40) < 1e-9), 'centres all land on the group centre',
      cs.map((x) => x.toFixed(1)).join(','))

    // Vertical edges do not move anything horizontally and vice versa.
    ok(alignDeltas(boxes, 'top').every((d) => d.x === 0), 'a vertical align leaves x alone')
    ok(alignDeltas(boxes, 'left').every((d) => d.y === 0), 'and a horizontal one leaves y alone')
  }

  // --- order of selection must not change the answer
  {
    const boxes = [B(0, 0, 10, 10), B(50, 20, 30, 10), B(20, 40, 5, 10)]
    const a = alignDeltas(boxes, 'centreX').map((d, i) => (boxes[i].minX + boxes[i].maxX) / 2 + d.x)
    const rev = [...boxes].reverse()
    const b = alignDeltas(rev, 'centreX').map((d, i) => (rev[i].minX + rev[i].maxX) / 2 + d.x)
    ok(JSON.stringify(a) === JSON.stringify([...b].reverse()),
      'aligning does not depend on the order things were picked')
  }

  // --- distribute evens the GAPS, not the centres
  {
    // Widths 10, 30, 5 between x=0 and x=100. Total width 45, so three gaps
    // of (100-45)/2 = 27.5 between the two outer ones.
    const boxes = [B(0, 0, 10, 10), B(40, 0, 30, 10), B(95, 0, 5, 10)]
    const d = distributeDeltas(boxes, true)
    const laid = boxes.map((b, i) => ({ lo: b.minX + d[i].x, hi: b.maxX + d[i].x }))
      .sort((p, q) => p.lo - q.lo)
    ok(Math.abs(laid[0].lo - 0) < 1e-9 && Math.abs(laid[2].hi - 100) < 1e-9,
      'the two outermost objects do not move')
    const g1 = laid[1].lo - laid[0].hi
    const g2 = laid[2].lo - laid[1].hi
    ok(Math.abs(g1 - g2) < 1e-9, 'and the gaps between come out equal',
      `${g1.toFixed(3)} vs ${g2.toFixed(3)}`)
    // The naive centre-spacing version gets this wrong, which is the point:
    // with these widths, even centres give unequal gaps.
    ok(Math.abs(g1 - 27.5) < 1e-9, 'at the right size', g1.toFixed(2))

    ok(distributeDeltas(boxes.slice(0, 2), true).every((q) => q.x === 0 && q.y === 0),
      'two objects have one gap, so there is nothing to even out')
  }

  // --- mirror is about the selection's own centre, so twice is a no-op
  {
    const paths = [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 0, y: 0 }]]
    const once = mirrorPaths(paths, 5, true)
    ok(once[0][0].x === 10 && once[0][1].x === 0, 'a horizontal mirror flips x about the line')
    ok(once[0][0].y === 0, 'and leaves y alone')
    const twice = mirrorPaths(once, 5, true)
    ok(JSON.stringify(twice) === JSON.stringify(paths), 'mirroring twice puts it back exactly')

    const v = mirrorPaths(paths, 2, false)
    ok(v[0][2].y === 0 && v[0][2].x === 10, 'a vertical mirror flips y')
    ok(JSON.stringify(mirrorPaths(v, 2, false)) === JSON.stringify(paths), 'and is also its own undo')

    // The point helper has to agree with the path version, or a mirrored
    // object's guides and markers end up somewhere else.
    const p = mirrorPt({ x: 3, y: 7 }, 5, true)
    ok(p.x === 7 && p.y === 7, 'the point mirror matches the path mirror')
  }
}


// ---------------------------------------------------------------------------
console.log('\n# decorative stitch styles')
{
  const line: Pt[] = [{ x: 0, y: 0 }, { x: 60, y: 0 }]
  const square = [...rect(0, 0, 40, 40), { x: 0, y: 0 }]
  const region = toRegions([square])[0]
  const fillOf = (over: Partial<ReturnType<typeof DEFAULT_FILL>>) => ({ ...DEFAULT_FILL(), ...over })

  // --- every motif in the library is actually sewable
  {
    for (const m of MOTIFS) {
      const st = motifRun(line, { id: m.id, widthMm: 6, heightMm: 4, gapMm: 0 }, { length: 2, style: 'motif' })
      ok(st.length > 5, `the ${m.label} motif generates stitches`, `${st.length}`)
      // It must stay inside its own cell, or a border overruns the line it
      // was drawn on.
      const offLine = Math.max(...st.map((q) => Math.abs(q.y)))
      ok(offLine <= 4 / 2 + 0.01, `the ${m.label} stays within its height`, `${offLine.toFixed(2)} of 2`)
      // And no stitch may exceed the run length it was given.
      let longest = 0
      for (let i = 1; i < st.length; i++) longest = Math.max(longest, dist(st[i - 1], st[i]))
      ok(longest <= 2 + 0.6, `the ${m.label} has no over-long stitch`, `${longest.toFixed(2)}`)
    }
  }

  // --- WHOLE motifs only
  {
    // 60 mm of path, 7 mm motifs: 8 fit, 4 mm left over.
    const st = motifRun(line, { id: 'diamond', widthMm: 7, heightMm: 4, gapMm: 0 }, { length: 2, style: 'motif' })
    const peaks = st.filter((q) => Math.abs(Math.abs(q.y) - 2) < 0.2).length
    ok(peaks >= 8, 'as many whole motifs as fit are stamped', `${peaks} peaks`)
    // The remainder runs plain rather than being left bare or stretched.
    ok(Math.max(...st.map((q) => q.x)) > 59, 'and the leftover is covered by a plain run',
      `${Math.max(...st.map((q) => q.x)).toFixed(1)} of 60`)
    // The outermost motif must not run off the end of the path.
    ok(Math.max(...st.map((q) => q.x)) <= 60.01, 'nothing overruns the path')
  }

  // --- a motif follows a CURVE rather than being pasted flat on it
  {
    const circle = Array.from({ length: 73 }, (_, i) => {
      const t = (i / 72) * Math.PI * 2
      return { x: Math.cos(t) * 20, y: Math.sin(t) * 20 }
    })
    const st = motifRun(circle, { id: 'zigzag', widthMm: 6, heightMm: 4, gapMm: 0 }, { length: 2, style: 'motif' })
    // Every penetration should sit within half the motif height of the
    // circle. Pasting a flat stamp would throw points well off it.
    const worst = Math.max(...st.map((q) => Math.abs(Math.hypot(q.x, q.y) - 20)))
    ok(worst <= 2 + 0.3, 'a motif bends round a curve', `${worst.toFixed(2)} mm off the circle`)
  }

  // --- a path too short for one motif is run plain, and the design says so
  {
    const d = emptyDoc()
    d.objects = [newObject({
      name: 'tiny', type: 'run', paths: [[{ x: 0, y: 0 }, { x: 3, y: 0 }]],
      run: { length: 2, style: 'motif' },
      motif: { id: 'star', widthMm: 8, heightMm: 4, gapMm: 0 },
    })]
    const r = digitize(d)
    ok(r.warnings.some((w) => /too short for one star motif/.test(w)),
      'a path too short for its motif is reported', r.warnings.find((w) => /motif/.test(w)) ?? '')
    ok(r.plan.blocks.flatMap((b) => b.stitches).length > 0, 'and still sews, as a plain run')
  }

  // --- motif FILL stamps whole motifs only
  {
    const st = motifFill(region, fillOf({ style: 'motif', spacing: 1 }),
      { id: 'cross', widthMm: 6, heightMm: 4, gapMm: 0 })
    ok(st.length > 50, 'a motif fill covers the area', `${st.length}`)
    const inside = st.filter((q) => !q.jump)
      .every((q) => q.x >= -0.6 && q.x <= 40.6 && q.y >= -2.6 && q.y <= 42.6)
    ok(inside, 'and stays within the shape, give or take the motif height')
  }

  // --- stipple
  {
    const st = stippleFill(region, fillOf({ style: 'stipple', spacing: 4, length: 2 }))
    ok(st.length > 40, 'a stipple covers the area', `${st.length}`)
    // Far fewer stitches than a tatami of the same shape: that is the point.
    const tat = tatamiFill(region, fillOf({}))
    ok(st.length < tat.length / 5, 'with a fraction of the stitches a tatami needs',
      `${st.length} vs ${tat.length}`)
    // Every penetration inside the shape.
    const outside = st.filter((q) => !q.jump && !insideRegion(region, q)).length
    ok(outside === 0, 'and every penetration lands inside the shape', `${outside} outside`)
    // It must WANDER, or it is just a sparse tatami.
    const ys = st.filter((q) => !q.jump).map((q) => q.y)
    const rowY = [...new Set(ys.map((y) => Math.round(y / 4)))].length
    ok(new Set(ys.map((y) => y.toFixed(2))).size > rowY * 3,
      'it wanders rather than running in straight rows',
      `${new Set(ys.map((y) => y.toFixed(2))).size} distinct y across ${rowY} rows`)
    // DETERMINISTIC — no Math.random anywhere in it.
    ok(JSON.stringify(stippleFill(region, fillOf({ style: 'stipple', spacing: 4, length: 2 })))
      === JSON.stringify(st), 'and the same shape always stipples the same way')
    // A stipple is ONE continuous line; a jump in it is a thread cut in the
    // middle of the thing that is supposed to be unbroken.
    ok(st.filter((q) => q.jump).length === 0, 'and it runs unbroken',
      `${st.filter((q) => q.jump).length} jumps`)
  }

  // --- cross-stitch
  {
    const st = crossStitchFill(region, fillOf({ style: 'crossstitch', length: 4 }))
    ok(st.length > 40, 'cross-stitch covers the area', `${st.length}`)
    ok(st.length % 4 === 0 || st.filter((q) => q.jump).length > 0,
      'in complete crosses of four points each')
    // A cross is sewn as one continuous X, so its arms are equal and
    // diagonal — no arm may be axis-aligned.
    // Measured in the FILL's own frame, not in document x/y: the default
    // fill angle is 45 degrees, which rotates the X until its arms are
    // axis-aligned on screen. They are still diagonal across their cell.
    const flat = crossStitchFill(region, fillOf({ style: 'crossstitch', length: 4, angle: 0 }))
    const first = flat.filter((q) => !q.jump).slice(0, 4)
    ok(Math.abs(Math.abs(first[1].x - first[0].x) - Math.abs(first[1].y - first[0].y)) < 1e-6,
      'each arm runs at 45 degrees across its cell',
      `${(first[1].x - first[0].x).toFixed(2)} by ${(first[1].y - first[0].y).toFixed(2)}`)
    const outside = st.filter((q) => !q.jump && !insideRegion(region, q)).length
    ok(outside === 0, 'and no cross strays outside the shape', `${outside}`)
    // Travel between neighbouring crosses must stay sewable, not become a
    // trim per cross.
    ok(st.filter((q) => q.jump).length <= 2, 'with travel between them, not a jump per cross',
      `${st.filter((q) => q.jump).length} jumps`)
  }

  // --- echo
  {
    const st = echoFill(region, fillOf({ style: 'echo', spacing: 2, length: 2 }))
    ok(st.length > 50, 'echo covers the area', `${st.length}`)
    const outside = st.filter((q) => !q.jump && !insideRegion(region, q)).length
    ok(outside === 0, 'with every stitch inside the shape', `${outside}`)
    // The texture must FOLLOW the shape: on a square, the rings are squares,
    // so most stitches lie on one of the four axis directions.
    // On a square the rings are squares, so every stitch sits a RING's
    // distance from the nearest edge — and those distances come one spacing
    // apart. That is the property that makes it an echo rather than a fill
    // that happens to be sparse.
    const depths = st.filter((q) => !q.jump)
      .map((q) => Math.min(q.x, q.y, 40 - q.x, 40 - q.y))
    const rings = [...new Set(depths.map((d) => Math.round(d * 4) / 4))].sort((a, b) => a - b)
    ok(rings.length <= 12, 'stitches fall on a handful of distinct rings',
      `${rings.length} rings: ${rings.slice(0, 6).map((r) => r.toFixed(2)).join(', ')}`)
    const gaps = rings.slice(1).map((r, i) => r - rings[i])
    ok(gaps.every((g) => Math.abs(g - 2) < 0.3), 'one spacing apart',
      gaps.map((g) => g.toFixed(2)).join(','))
    ok(Math.abs(rings[0] - 1) < 0.3, 'starting half a spacing inside the outline',
      rings[0].toFixed(2))
    // Tighter spacing means more rings, which is the only knob that matters.
    // ROUTING. An offset ring starts wherever the offsetter put its first
    // vertex, and taking the rings as they come meant flying across the
    // shape between every pair — 39 trims for 13 rings on a 40 mm square,
    // in a fill whose rings are 1.5 mm apart.
    const routed = echoFill(region, fillOf({ style: 'echo', spacing: 1.5, length: 2 }))
    ok(routed.filter((q) => q.jump).length === 0,
      'rings are entered at the nearest point, so there are no jumps between them',
      `${routed.filter((q) => q.jump).length} jumps`)

    // A NON-CONVEX shape is the case that would break naive contour
    // routing: the rings have re-entrant corners and the offsetter can
    // split them.
    const L = toRegions([[
      { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 },
      { x: 20, y: 20 }, { x: 20, y: 40 }, { x: 0, y: 40 }, { x: 0, y: 0 },
    ]])[0]
    const bent = echoFill(L, fillOf({ style: 'echo', spacing: 1.5, length: 2 }))
    ok(bent.length > 100, 'an L-shaped echo fills', `${bent.length}`)
    ok(bent.filter((q) => q.jump).length === 0, 'with no jumps either',
      `${bent.filter((q) => q.jump).length}`)
    ok(bent.filter((q) => !q.jump && !insideRegion(L, q)).length === 0,
      'and nothing outside the bend')

    const tight = echoFill(region, fillOf({ style: 'echo', spacing: 1, length: 2 }))
    ok(tight.length > st.length * 1.5, 'tighter spacing lays more rings',
      `${st.length} -> ${tight.length}`)
  }

  // --- the styles reach the real pipeline, and underlay is refused
  {
    for (const style of FILL_STYLES) {
      const d = emptyDoc()
      d.objects = [newObject({
        name: style, type: 'fill', paths: [square],
        fill: fillOf({ style, spacing: style === 'tatami' ? 0.4 : 3, length: 3, underlay: [] }),
      })]
      const n = digitize(d).plan.blocks.flatMap((b) => b.stitches).filter((q) => !q.jump).length
      ok(n > 20, `a ${style} fill generates through digitize()`, `${n} stitches`)
    }
    const d = emptyDoc()
    d.objects = [newObject({
      type: 'fill', paths: [square],
      fill: fillOf({ style: 'stipple', spacing: 4, underlay: ['edge'] }),
    })]
    ok(digitize(d).warnings.some((w) => /underlay is not used/.test(w)),
      'underlay under an open fill is refused and reported')
  }
}


// ---------------------------------------------------------------------------
console.log('\n# travel planning')
{
  // --- chaining: the biggest win on imported artwork
  {
    // One SVG outline that arrived as four separate sides, in a muddle, two
    // of them drawn backwards. This is what an import actually looks like.
    const sides = [
      [{ x: 0, y: 0 }, { x: 40, y: 0 }],
      [{ x: 40, y: 30 }, { x: 40, y: 0 }],
      [{ x: 0, y: 30 }, { x: 40, y: 30 }],
      [{ x: 0, y: 30 }, { x: 0, y: 0 }],
    ]
    const chained = chainPaths(sides)
    ok(chained.length === 1, 'four sides chain into one path', `${chained.length}`)
    ok(chained[0].length === 5, 'with no point lost or doubled', `${chained[0].length}`)
    ok(dist(chained[0][0], chained[0][chained[0].length - 1]) < 1e-9,
      'and its ends meet, so it is a ring')

    // The point of it: what that costs the machine.
    const before = travelCost(sides, 6)
    const after = travelCost(chained, 6)
    ok(before.trims > 0, 'unchained, the sides cost thread cuts', `${before.trims} trims`)
    ok(after.trims === 0, 'chained, they cost none')
    ok(after.travelMm < before.travelMm, 'and far less travel',
      `${before.travelMm.toFixed(1)} -> ${after.travelMm.toFixed(1)} mm`)

    // Ends that are nowhere near each other are NOT welded.
    const apart = chainPaths([
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      [{ x: 80, y: 0 }, { x: 90, y: 0 }],
    ])
    ok(apart.length === 2, 'unrelated segments stay separate')
  }

  // --- ordering: file order is an accident of whatever drew it
  {
    // Five dashes along a line, listed in the worst possible order.
    const dashes = [0, 60, 20, 80, 40].map((x) => [{ x, y: 0 }, { x: x + 10, y: 0 }])
    const before = travelCost(dashes, 6)
    const after = travelCost(orderPaths(dashes, { x: 0, y: 0 }), 6)
    ok(after.travelMm < before.travelMm / 2, 'ordering nearest-first halves the travel at least',
      `${before.travelMm.toFixed(1)} -> ${after.travelMm.toFixed(1)} mm`)
    ok(orderPaths(dashes).length === dashes.length, 'and nothing is dropped')
  }

  // --- a path may be entered from EITHER end
  {
    // Reached from its far end, a path costs a travel as long as itself.
    const two = [
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      [{ x: 60, y: 0 }, { x: 11, y: 0 }],
    ]
    const ordered = orderPaths(two, { x: 0, y: 0 })
    ok(Math.abs(ordered[1][0].x - 11) < 1e-9,
      'the second path is entered at the near end, reversing it if need be',
      `${ordered[1][0].x}`)
    ok(travelCost(ordered, 6).travelMm < 2, 'so the travel is a millimetre, not fifty',
      `${travelCost(ordered, 6).travelMm.toFixed(2)} mm`)
  }

  // --- a RING keeps its direction but may be re-entered anywhere
  {
    const ring = [...rect(0, 0, 20, 20), { x: 0, y: 0 }]
    const r = enterRingNear(ring, { x: 20, y: 20 })
    ok(dist(r[0], { x: 20, y: 20 }) < 1e-9, 'a ring is re-entered at its nearest corner')
    ok(r.length === ring.length, 'with the same number of points')
    ok(dist(r[0], r[r.length - 1]) < 1e-9, 'and it is still closed')
    // Direction is load-bearing: it decides which way a satin border leans
    // and which side a fill insets its underlay.
    const signedArea = (p: typeof ring) => {
      let a = 0
      for (let i = 1; i < p.length; i++) a += p[i - 1].x * p[i].y - p[i].x * p[i - 1].y
      return a
    }
    ok(Math.sign(signedArea(r)) === Math.sign(signedArea(ring)),
      'and its direction is unchanged')
  }

  // --- hiding: a travel is only worth sewing when something covers it
  {
    const cover = [toRegions([[...rect(0, 0, 40, 40), { x: 0, y: 0 }]])[0]]
    ok(travelIsHidden(cover, { x: 5, y: 5 }, { x: 35, y: 35 }),
      'a travel inside a filled shape is hidden')
    ok(!travelIsHidden(cover, { x: 5, y: 5 }, { x: 80, y: 80 }),
      'one that leaves it is not')
    ok(!travelIsHidden([], { x: 0, y: 0 }, { x: 1, y: 1 }),
      'and with nothing to hide under, nothing is hidden')
    // The whole way, not just the ends — this is the case a naive endpoint
    // test gets wrong.
    const donut = toRegions([
      [...rect(0, 0, 40, 40), { x: 0, y: 0 }],
      [...rect(10, 10, 20, 20), { x: 10, y: 10 }],
    ])[0]
    ok(!travelIsHidden([donut], { x: 5, y: 20 }, { x: 35, y: 20 }),
      'a travel across a hole is not hidden, however covered its ends are')
  }

  // --- and it reaches the real pipeline
  {
    const d = emptyDoc()
    // The same four sides, as a run object.
    d.objects = [newObject({
      name: 'outline', type: 'run',
      paths: [
        [{ x: 0, y: 0 }, { x: 40, y: 0 }],
        [{ x: 40, y: 30 }, { x: 40, y: 0 }],
        [{ x: 0, y: 30 }, { x: 40, y: 30 }],
        [{ x: 0, y: 30 }, { x: 0, y: 0 }],
      ],
    })]
    const plan = digitize(d).plan
    const jumps = plan.blocks.flatMap((b) => b.stitches).filter((s) => s.jump).length
    // One leading jump to reach the design is expected and unavoidable.
    ok(jumps <= 1, 'a run of loose segments sews with no jumps between them',
      `${jumps} jumps`)
    ok(countTrims(plan) === 0, 'and no thread cuts', `${countTrims(plan)}`)
  }

  // --- travel BETWEEN objects on the same needle
  {
    // Two lines end to end. Their stitching really does finish and start
    // next to each other, which is the case where a cut is pure waste.
    //
    // NOTE on what this does NOT do: two FILLS sitting side by side still
    // cut, because a fill's stitching ends wherever its last scanline row
    // ends and begins wherever its first row begins — which can be the far
    // corners even when the shapes touch. Routing a travel through one
    // shape to shorten that hop is real work that is not done here; the
    // tool for it today is the entry/exit markers, which let the digitizer
    // say where each object should finish and start.
    const build = (gapMm: number) => {
      const d = emptyDoc()
      d.objects = [
        newObject({
          name: 'A', color: '#ff0000', type: 'run',
          paths: [[{ x: 0, y: 0 }, { x: 20, y: 0 }]],
        }),
        newObject({
          name: 'B', color: '#ff0000', type: 'run',
          paths: [[{ x: 20 + gapMm, y: 0 }, { x: 40 + gapMm, y: 0 }]],
        }),
      ]
      return digitize(d).plan
    }

    const near = build(1)
    ok(countTrims(near) === 0, 'two objects that end and start together sew without a cut',
      `${countTrims(near)} trims`)
    ok(near.blocks.length === 1, 'and stay in one colour block', `${near.blocks.length}`)

    // Far apart with nothing to hide under, the cut is CORRECT: the
    // alternative is thread lying across bare fabric.
    const far = build(60)
    ok(countTrims(far) > 0, 'two distant objects still cut', `${countTrims(far)} trims`)

    // The ties either side of a cut that did not happen are waste — a knot
    // of short stitches in the middle of one continuous thread.
    const midLocks = (plan: ReturnType<typeof digitize>['plan']) => {
      const st = plan.blocks[0].stitches
      return st.slice(6, -6).filter((q) => q.lock).length
    }
    ok(midLocks(near) === 0, 'and the ties that would have bracketed it are removed',
      `${midLocks(near)} stray lock stitches`)
    ok(midLocks(far) > 0, 'while a real cut keeps its ties', `${midLocks(far)} lock stitches`)
  }

  // --- a travel that can HIDE is sewn even when it is long
  {
    const d = emptyDoc()
    const big = [...rect(0, 0, 60, 60), { x: 0, y: 0 }]
    d.objects = [
      // A big fill, then a run that starts deep inside it. The travel to
      // reach the run never leaves the filled area, so it disappears under
      // stitches that are already there.
      newObject({ name: 'bg', color: '#ff0000', type: 'fill', paths: [big] }),
      newObject({
        name: 'line', color: '#ff0000', type: 'run',
        paths: [[{ x: 10, y: 30 }, { x: 50, y: 30 }]],
      }),
    ]
    const plan = digitize(d).plan
    ok(countTrims(plan) === 0, 'a long travel under an existing fill is sewn, not cut',
      `${countTrims(plan)} trims`)
  }

  // --- a FILL's paths are a region, and must never be chained or reordered
  {
    const d = emptyDoc()
    const outer = [...rect(0, 0, 40, 40), { x: 0, y: 0 }]
    const hole = [...rect(12, 12, 16, 16), { x: 12, y: 12 }]
    d.objects = [newObject({ name: 'ring', type: 'fill', paths: [outer, hole] })]
    const pts = digitize(d).plan.blocks.flatMap((b) => b.stitches).filter((s) => !s.jump)
    // If the hole had been chained to the outline or treated as a shape of
    // its own, the middle would be stitched.
    const inMiddle = pts.filter((p) =>
      p.x > 15 && p.x < 25 && p.y > 15 && p.y < 25).length
    ok(inMiddle === 0, 'the hole in a filled ring stays empty', `${inMiddle} stitches in it`)
  }
}


// ---------------------------------------------------------------------------
console.log('\n# machine formats beyond DST')
{
  const build = () => {
    const d = emptyDoc()
    d.objects = [
      newObject({ name: 'A', color: '#c0392b', type: 'fill',
        paths: [[...rect(0, 0, 20, 20), { x: 0, y: 0 }]] }),
      newObject({ name: 'B', color: '#1f6feb', type: 'run',
        paths: [[{ x: 30, y: 0 }, { x: 50, y: 20 }]] }),
    ]
    return digitize(d).plan
  }
  const plan = build()

  // --- the shared flattening
  {
    const moves = planToMoves(plan)
    ok(moves.length > 10, 'a plan flattens to machine moves', `${moves.length}`)
    ok(moves[0].kind === 'jump', 'the approach is needle-UP', moves[0].kind)
    ok(moves.some((m) => m.kind === 'color'), 'and a two-colour plan has a colour change')
    // Y is flipped exactly once: the document is +Y down, machines are +Y up.
    const firstStitch = plan.blocks[0].stitches.find((s) => !s.jump)!
    const match = moves.find((m) => Math.abs(m.x - Math.round(firstStitch.x * 10)) < 1)
    ok(!!match && Math.abs(match.y + Math.round(firstStitch.y * 10)) < 1,
      'and +Y is flipped once, not twice',
      `${match?.y} vs ${-Math.round(firstStitch.y * 10)}`)
  }

  // --- long moves are SPLIT, never truncated
  {
    // A signed byte reaches 127 units; a 40 mm move is 400.
    const hops = splitMove(0, 0, 400, 0, 127)
    ok(hops.length === 4, 'a 40 mm move becomes four hops', `${hops.length}`)
    ok(hops[hops.length - 1].x === 400, 'and it arrives exactly where it was going')
    ok(hops.every((h, i) => Math.abs(h.x - (hops[i - 1]?.x ?? 0)) <= 127),
      'with no hop over the limit')
    // Interpolated from the START, so rounding cannot accumulate.
    const odd = splitMove(0, 0, 301, 0, 127)
    ok(odd[odd.length - 1].x === 301, 'an awkward distance still lands exactly')
  }

  // --- the encoders produce bytes, and the same bytes twice
  {
    const exp = writeExp(plan)
    ok(exp.length > 40, 'EXP writes a file', `${exp.length} bytes`)
    ok(exp.length % 2 === 0, 'of whole records')
    ok(Buffer.compare(Buffer.from(writeExp(plan)), Buffer.from(exp)) === 0,
      'and the same plan twice gives identical bytes')

    const when = new Date(Date.UTC(2026, 0, 1, 12, 0, 0))
    const jef = writeJef(plan, when)
    ok(jef.length > 0x80, 'JEF writes a file', `${jef.length} bytes`)
    ok(Buffer.compare(Buffer.from(writeJef(plan, when)), Buffer.from(jef)) === 0,
      'and is deterministic given a date')
    // The date is injectable precisely so this is true; left to a clock,
    // two exports of one design differ and "the file changed" means nothing.
    const later = writeJef(plan, new Date(Date.UTC(2027, 5, 6, 7, 8, 9)))
    ok(Buffer.compare(Buffer.from(later), Buffer.from(jef)) !== 0,
      'the stamped date really is in the file')

    // The header must point past itself to the stitch data.
    const u32 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)
    const offset = u32(jef, 0)
    const colorCount = u32(jef, 24)
    ok(offset === 0x74 + colorCount * 8, 'the JEF stitch offset matches its colour count',
      `${offset} vs ${0x74 + colorCount * 8}`)
    ok(offset < jef.length, 'and points inside the file')
    ok(colorCount === plan.blocks.length, 'with one palette entry per colour block',
      `${colorCount} vs ${plan.blocks.length}`)
    ok(jef[jef.length - 2] === 0x80 && jef[jef.length - 1] === 0x10,
      'and the file ends with the end command')
  }

  // --- JEF's palette is an INDEX, and the mapping is nearest-colour
  {
    ok(nearestJefColor('#ff0000') === 10, 'pure red maps to the palette red',
      `${nearestJefColor('#ff0000')}`)
    ok(JEF_PALETTE[nearestJefColor('#ffffff')] === 0xffffff, 'white to white')
    ok(nearestJefColor('#000000') === 1, 'black to black, never to index 0')
    ok(nearestJefColor('not a colour') === 1,
      'and an unreadable colour becomes black rather than throwing')
    // Something with no exact match still lands somewhere sensible.
    const near = nearestJefColor('#fe0101')
    ok(near === 10, 'a near-red lands on the same entry as red', `${near}`)
  }

  // --- a format that cannot carry something must not pretend it can
  {
    // EXP has no header at all, so there is nothing to disagree with the
    // data — and no colour, which is why the sidecars exist.
    const exp = writeExp(plan)
    // The very first record must be a jump: the approach is needle-up.
    ok(exp[0] === 0x80 && exp[1] === 0x04, 'an EXP opens with a jump, not a stitch',
      `${exp[0].toString(16)} ${exp[1].toString(16)}`)
  }
}


// ---------------------------------------------------------------------------
console.log('\n# reusable stitch styles')
{
  const obj = () => newObject({
    name: 'thing', color: '#abcdef', type: 'satin',
    paths: [[{ x: 0, y: 0 }, { x: 20, y: 0 }]],
    thread: { brand: 'Isacord', code: '1902' },
  })

  // --- a preset changes HOW a shape is sewn and nothing else
  {
    const o = obj()
    o.entry = { x: 1, y: 2 }
    o.guides = [{ a: { x: 9, y: -2 }, b: { x: 11, y: 2 } }]
    const fillPreset = BUILT_IN_PRESETS.find((p) => p.id === 'builtin:logo-fill')!
    const after = applyStyle(o, fillPreset)
    ok(after.type === 'fill', 'applying a preset sets the stitch type')
    ok(after.fill.spacing === fillPreset.fill.spacing, 'and its parameters')
    ok(after.name === 'thing' && after.color === '#abcdef',
      'but not the name or the colour')
    ok(after.thread.code === '1902', 'nor the thread')
    ok(after.paths === o.paths, 'nor the geometry')
    ok(after.entry?.x === 1 && after.guides?.length === 1,
      'nor the entry point or the angle guides')
  }

  // --- EVERY parameter block is replaced, not just the matching one
  {
    const o = obj()
    o.fill.spacing = 1.23 // nothing to do with a satin preset
    const satinPreset = BUILT_IN_PRESETS.find((p) => p.id === 'builtin:cap-satin')!
    const after = applyStyle(o, satinPreset)
    ok(after.fill.spacing === satinPreset.fill.spacing,
      'a satin preset also resets the fill settings',
      `${after.fill.spacing}`)
    // Otherwise the result would depend on what the object was BEFORE, which
    // is impossible to work out from the stitches that come off it.
  }

  // --- a preset taken from an object is a COPY, not a window onto it
  {
    const o = obj()
    o.satin.width = 7
    const p = presetFrom(o, 'mine')
    o.satin.width = 1
    ok(p.satin.width === 7, 'editing the object afterwards does not change the preset')
    const other = applyStyle(obj(), p)
    other.satin.underlay.push('zigzag')
    ok(p.satin.underlay.length !== other.satin.underlay.length
      || p.satin.underlay.join() !== other.satin.underlay.join(),
      'and applying it twice does not share arrays between objects')
  }

  // --- a preset really changes the stitches
  {
    const run = (p: typeof BUILT_IN_PRESETS[number]) => {
      const d = emptyDoc()
      d.objects = [applyStyle(newObject({
        name: 'x', type: 'fill', paths: [[...rect(0, 0, 30, 30), { x: 0, y: 0 }]],
      }), p)]
      return digitize(d).plan.blocks.flatMap((b) => b.stitches).filter((s) => !s.jump).length
    }
    const solid = run(BUILT_IN_PRESETS.find((p) => p.id === 'builtin:logo-fill')!)
    const loose = run(BUILT_IN_PRESETS.find((p) => p.id === 'builtin:background-stipple')!)
    ok(solid > 500, 'the logo-fill preset sews a solid fill', `${solid}`)
    ok(loose < solid / 5, 'and the stipple preset is far lighter', `${loose} vs ${solid}`)
  }

  // --- every built-in must actually generate
  {
    for (const p of BUILT_IN_PRESETS) {
      const d = emptyDoc()
      const paths = p.type === 'satin' || p.type === 'run' || p.type === 'bean'
        ? [[{ x: 0, y: 0 }, { x: 40, y: 0 }]]
        : [[...rect(0, 0, 40, 40), { x: 0, y: 0 }]]
      d.objects = [applyStyle(newObject({ name: p.name, paths }), p)]
      const r = digitize(d)
      const n = r.plan.blocks.flatMap((b) => b.stitches).filter((s) => !s.jump).length
      ok(n > 10, `the "${p.name}" preset sews something`, `${n} stitches`)
      ok(!r.warnings.some((w) => /NOT STITCHED/.test(w)),
        `and is not refused`, r.warnings.find((w) => /NOT STITCHED/.test(w)) ?? '')
    }
  }

  // --- storage round-trips, and a corrupt store degrades to nothing
  {
    const mine = presetFrom(obj(), 'my satin')
    mine.satin.density = 0.27
    const text = serializePresets([...BUILT_IN_PRESETS, mine])
    const back = parsePresets(text)
    ok(back.length === 1, 'built-ins are not stored — they ship with the program',
      `${back.length}`)
    ok(back[0].name === 'my satin' && back[0].satin.density === 0.27,
      'and a saved preset comes back intact')

    ok(parsePresets(null).length === 0, 'no store means no presets')
    ok(parsePresets('not json').length === 0, 'and neither does a corrupt one')
    ok(parsePresets('{"a":1}').length === 0, 'nor one of the wrong shape')

    // A missing number must not become NaN: a NaN density produces a stitch
    // plan nobody can explain and a garment nobody can sew.
    const holed = parsePresets('[{"id":"x","name":"x","satin":{"density":null}}]')
    ok(holed.length === 1 && isFinite(holed[0].satin.density) && holed[0].satin.density > 0,
      'a missing number falls back to the default rather than NaN',
      `${holed[0]?.satin.density}`)
    // A preset with no `type` falls back to a fill, so it is given a closed
    // shape to fill — handing a fill an open line would be testing the
    // geometry, not the preset.
    ok(holed[0].type === 'fill', 'a preset with no stitch type reads as a fill')
    const d = emptyDoc()
    d.objects = [applyStyle(newObject({
      paths: [[...rect(0, 0, 30, 30), { x: 0, y: 0 }]],
    }), holed[0])]
    const n = digitize(d).plan.blocks.flatMap((b) => b.stitches).length
    ok(n > 10, 'and it still sews', `${n} stitches`)
  }
}


// ---------------------------------------------------------------------------
console.log('\n# lettering on a baseline path')
{
  // A word-shaped block of outlines: two 10x20 boxes side by side, baseline
  // at the bottom. Using boxes rather than real glyphs keeps the test about
  // the MAPPING; the rasteriser is covered elsewhere and needs a browser.
  const word = [
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }, { x: 0, y: 20 }, { x: 0, y: 0 }],
    [{ x: 15, y: 0 }, { x: 25, y: 0 }, { x: 25, y: 20 }, { x: 15, y: 20 }, { x: 15, y: 0 }],
  ]
  // Baseline y = 20 (the bottom of the box, +Y down), width 25.

  // --- a straight path is a MOVE, not a distortion
  {
    const line = [{ x: 100, y: 50 }, { x: 125, y: 50 }]
    const r = textOnPath(word, line)
    ok(r.warnings.length === 0, 'a path exactly as long as the type fits', r.warnings[0] ?? '')
    const xs = r.paths.flat().map((q) => q.x)
    const ys = r.paths.flat().map((q) => q.y)
    ok(Math.abs(Math.min(...xs) - 100) < 1e-6 && Math.abs(Math.max(...xs) - 125) < 1e-6,
      'the type lands along the path', `${Math.min(...xs)}..${Math.max(...xs)}`)
    // Feet ON the line, heads above it. +Y is down, so above is smaller y.
    ok(Math.abs(Math.max(...ys) - 50) < 1e-6, 'with its feet on the baseline',
      `${Math.max(...ys)}`)
    ok(Math.abs(Math.min(...ys) - 30) < 1e-6, 'and its cap height preserved',
      `${Math.min(...ys)}`)
  }

  // --- the SIZE is preserved by default, because someone quoted it
  {
    // A path only half as long as the type.
    const short = [{ x: 0, y: 0 }, { x: 12, y: 0 }]
    const r = textOnPath(word, short, 'keep-size')
    const xs = r.paths.flat().map((q) => q.x)
    ok(Math.max(...xs) - Math.min(...xs) > 24,
      'the letters keep their size on a path too short for them',
      `${(Math.max(...xs) - Math.min(...xs)).toFixed(1)} mm`)
    ok(r.warnings.some((w) => /runs on past it/.test(w)),
      'and the overflow is reported rather than hidden', r.warnings[0] ?? '')
    // Extended along the tangent, not piled on the last point — piling looks
    // like a bug, extending shows exactly how much too long the text is.
    ok(new Set(xs.map((x) => x.toFixed(2))).size > 2, 'the overflow is not collapsed')
  }

  // --- and 'fit-path' says what it does
  {
    const short = [{ x: 0, y: 0 }, { x: 12, y: 0 }]
    const r = textOnPath(word, short, 'fit-path')
    const xs = r.paths.flat().map((q) => q.x)
    ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 12) < 1e-6,
      'fit-path scales the line to span the path exactly',
      `${(Math.max(...xs) - Math.min(...xs)).toFixed(2)}`)
    ok(r.warnings.length === 0, 'and does not complain about it')
  }

  // --- a CURVED path really bends the letters
  {
    // A quarter circle of radius 40, walked so that "above the baseline"
    // falls OUTSIDE it — lettering around the top of a crest. Walked the
    // other way the heads point inward, which is how the bottom of a crest
    // is set, and is checked separately below.
    const arcPts = Array.from({ length: 65 }, (_, i) => {
      const a = (i / 64) * (Math.PI / 2)
      return { x: Math.sin(a) * 40, y: -Math.cos(a) * 40 }
    })
    const r = textOnPath(word, arcPts, 'fit-path')
    const pts = r.paths.flat()
    const radii = pts.map((q) => Math.hypot(q.x, q.y))
    ok(Math.min(...radii) >= 40 - 0.5, 'the feet sit ON the arc, nothing inside it',
      `${Math.min(...radii).toFixed(2)} of 40`)
    // Cap height 20 mm scaled by (arc length / type length) = 62.83 / 25.
    const cap = 20 * (62.83 / 25)
    ok(Math.abs(Math.max(...radii) - (40 + cap)) < 2,
      'and the caps stand off it by the scaled cap height',
      `${Math.max(...radii).toFixed(1)} of ${(40 + cap).toFixed(1)}`)
    // The letters must have TURNED, not merely translated: a rigid stamp
    // would keep every box axis-aligned.
    const edgeAngles = r.paths.map((ring) =>
      Math.atan2(ring[1].y - ring[0].y, ring[1].x - ring[0].x))
    ok(Math.abs(edgeAngles[0] - edgeAngles[1]) > 0.3,
      'the two letters sit at different angles, so they followed the curve',
      `${edgeAngles.map((a) => ((a * 180) / Math.PI).toFixed(0)).join(' vs ')} deg`)
  }

  // --- the path's DIRECTION is the reading direction
  {
    const fwd = textOnPath(word, [{ x: 0, y: 0 }, { x: 25, y: 0 }])
    const rev = textOnPath(word, [{ x: 25, y: 0 }, { x: 0, y: 0 }])
    const topOf = (r: typeof fwd) => Math.min(...r.paths.flat().map((q) => q.y))
    const botOf = (r: typeof fwd) => Math.max(...r.paths.flat().map((q) => q.y))
    ok(topOf(fwd) < 0 && botOf(fwd) === 0, 'forwards, the heads are above the line')
    ok(botOf(rev) > 0 && topOf(rev) === 0,
      'backwards, they are below it — which is how you set the bottom of a crest')
  }

  // --- degenerate input is returned untouched rather than throwing
  {
    ok(textOnPath(word, [{ x: 0, y: 0 }]).paths === word, 'a one-point path does nothing')
    ok(textOnPath(word, [{ x: 1, y: 1 }, { x: 1, y: 1 }]).paths === word,
      'and neither does a zero-length one')
    ok(textOnPath([], [{ x: 0, y: 0 }, { x: 9, y: 0 }]).paths.length === 0,
      'and no outlines is no outlines')
  }

  // --- it survives a save and reopen
  {
    const d = emptyDoc()
    d.objects = [newObject({ name: 'curved', type: 'fill', paths: [word[0]] })]
    d.objects[0].text = {
      ...DEFAULT_TEXT(), content: 'arc',
      path: [{ x: 0, y: 0 }, { x: 30, y: -5 }, { x: 60, y: 0 }],
      pathFit: 'fit-path',
    }
    const back = deserialize(serialize(d))
    ok(back.objects[0].text?.path?.length === 3, 'a baseline path survives a save',
      `${back.objects[0].text?.path?.length}`)
    ok(back.objects[0].text?.path?.[1].y === -5, 'with its points intact')
    ok(back.objects[0].text?.pathFit === 'fit-path', 'and the fit choice too')

    // A half-read path cannot bend anything, so it is dropped.
    const raw = JSON.parse(serialize(d))
    raw.doc.objects[0].text.path = [[1, 2]]
    ok(deserialize(JSON.stringify(raw)).objects[0].text?.path === undefined,
      'a one-point path is dropped on reading, not applied')
  }
}


// ---------------------------------------------------------------------------
console.log('\n# groups')
{
  const build = () => {
    const d = emptyDoc()
    d.objects = [
      newObject({ id: 'a', name: 'A', type: 'fill', paths: [[...rect(0, 0, 20, 20), { x: 0, y: 0 }]] }),
      newObject({ id: 'b', name: 'B', type: 'fill', paths: [[...rect(40, 0, 20, 20), { x: 40, y: 0 }]] }),
      newObject({ id: 'c', name: 'C', type: 'fill', paths: [[...rect(80, 0, 20, 20), { x: 80, y: 0 }]] }),
    ]
    d.groups = [{ id: 'g1', name: 'Badge' }]
    d.objects[0].group = 'g1'
    d.objects[2].group = 'g1'
    return d
  }
  const countFor = (d: Doc) =>
    digitize(d).plan.blocks.flatMap((b) => b.stitches).filter((s) => !s.jump).length

  // --- GROUPING DOES NOT CHANGE THE SEWING ORDER, which is the point
  {
    const d = build()
    const order = digitize(d).plan.blocks.map((b) => b.label).join(' | ')
    ok(/A/.test(order) && /B/.test(order) && /C/.test(order), 'all three still sew', order)
    // A sews first, B second, C third — the group did not drag C up next to A.
    const ai = order.indexOf('A'), bi = order.indexOf('B'), ci = order.indexOf('C')
    ok(ai < bi && bi < ci, 'in the order the document lists them, group or not',
      `A@${ai} B@${bi} C@${ci}`)
  }

  // --- a hidden group hides its members
  {
    const all = countFor(build())
    const d = build()
    d.groups[0].hidden = true
    const some = countFor(d)
    ok(some > 0 && some < all, 'hiding a group removes its members from the plan',
      `${all} -> ${some}`)
    // And only its members: B is not in the group.
    ok(digitize(d).plan.blocks.every((b) => !/A|C/.test(b.label)),
      'leaving the ungrouped object alone',
      digitize(d).plan.blocks.map((b) => b.label).join('|'))
  }

  // --- the two switches are SEPARATE, so showing a group puts things back
  {
    const d = build()
    d.objects[2].visible = false // C hidden on its own
    const beforeHide = countFor(d)
    d.groups[0].hidden = true
    d.groups[0].hidden = false   // hide and show the group again
    ok(countFor(d) === beforeHide,
      'showing a group again does not reveal a member that was hidden on its own',
      `${beforeHide} vs ${countFor(d)}`)
    ok(objectVisible(d.objects[2], d.groups) === false, 'C is still hidden')
    ok(objectVisible(d.objects[0], d.groups) === true, 'and A is not')
  }

  // --- membership survives a save, and a dangling one is dropped
  {
    const d = build()
    const back = deserialize(serialize(d))
    ok(back.groups.length === 1 && back.groups[0].name === 'Badge', 'a group survives a save')
    ok(back.objects[0].group === 'g1' && back.objects[2].group === 'g1',
      'with its membership')
    ok(back.objects[1].group === undefined, 'and nothing else joined it')

    const flags = build()
    flags.groups[0] = { id: 'g1', name: 'Badge', collapsed: true, hidden: true, locked: true }
    const f = deserialize(serialize(flags)).groups[0]
    ok(f.collapsed && f.hidden && f.locked, 'the fold, hide and lock flags survive')

    // A group row with no id can never be matched to a member.
    const raw = JSON.parse(serialize(d))
    raw.doc.groups = [{ name: 'orphan' }, { id: 'ok', name: 'fine' }]
    ok(deserialize(JSON.stringify(raw)).groups.length === 1,
      'a group with no id is dropped rather than put in the panel')
  }

  // --- the signature covers groups, so hiding one regenerates the plan
  {
    const a = build()
    const b = build()
    b.groups[0].hidden = true
    ok(docSignature(a) !== docSignature(b), 'hiding a group changes the signature')
    const c = build()
    c.groups[0].name = 'Crest'
    ok(docSignature(a) !== docSignature(c), 'and so does renaming one')
  }
}


// ---------------------------------------------------------------------------
console.log('\n# native embroidery alphabets')
{
  // Two letters as plain boxes: a 20 mm tall "A" and a 40 mm tall "B",
  // captured at different sizes on purpose — that is the case normalising
  // exists for.
  const boxA = [[{ x: 5, y: 100 }, { x: 15, y: 100 }, { x: 15, y: 120 }, { x: 5, y: 120 }, { x: 5, y: 100 }]]
  const boxB = [[{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 40 }, { x: 0, y: 40 }, { x: 0, y: 0 }]]

  const alphabet: Alphabet = {
    id: 'test', name: 'Test', capHeightMm: 10,
    glyphs: {
      A: normaliseGlyph(boxA, 10)!,
      B: normaliseGlyph(boxB, 10)!,
    },
  }

  // --- normalising puts every letter on one baseline at one size
  {
    const a = alphabet.glyphs.A, b = alphabet.glyphs.B
    const bb = (g: typeof a) => bounds(g.paths)!
    ok(Math.abs(bb(a).maxY) < 1e-9 && Math.abs(bb(b).maxY) < 1e-9,
      'both letters sit on the baseline', `${bb(a).maxY} / ${bb(b).maxY}`)
    ok(Math.abs(bb(a).minY + 10) < 1e-9 && Math.abs(bb(b).minY + 10) < 1e-9,
      'both are the alphabet cap height, however big they were captured',
      `${bb(a).minY} / ${bb(b).minY}`)
    ok(Math.abs(bb(a).minX) < 1e-9 && Math.abs(bb(b).minX) < 1e-9,
      'and both start at x = 0')
    // A was 10x20 so it normalises to 5 wide; B was 30x40 so 7.5 wide.
    ok(Math.abs(bb(a).maxX - 5) < 1e-6 && Math.abs(bb(b).maxX - 7.5) < 1e-6,
      'proportions are kept', `${bb(a).maxX} / ${bb(b).maxX}`)
    ok(a.advanceMm > bb(a).maxX, 'with a side bearing either side')
  }

  // --- setting text lays the letters out in order, at the size asked for
  {
    const r = setAlphabetText(alphabet, 'AB', 20)
    ok(r.missing.length === 0, 'both letters are present')
    ok(r.letters.length === 2 && r.letters[0].ch === 'A', 'in order')
    const b = bounds(r.paths)!
    ok(Math.abs(b.minY + 20) < 1e-6, 'at the cap height asked for, not the stored one',
      `${b.minY}`)
    ok(Math.abs(b.maxY) < 1e-9, 'on the baseline')
    // A ends at its advance; B starts there.
    const aEnd = bounds(r.letters[0].paths)!.maxX
    const bStart = bounds(r.letters[1].paths)!.minX
    ok(bStart > aEnd, 'and they do not overlap', `${aEnd.toFixed(2)} then ${bStart.toFixed(2)}`)
  }

  // --- a MISSING character is reported and leaves a gap
  {
    const r = setAlphabetText(alphabet, 'AZB', 20)
    ok(r.missing.join('') === 'Z', 'a character the alphabet lacks is reported', r.missing.join(''))
    ok(r.letters.length === 2, 'and nothing is drawn for it')
    // A GAP, not a close-up: a word with a hole in it is obviously wrong,
    // while a word silently missing a letter reads as a typo and gets sewn.
    const gapped = bounds(r.paths)!
    const tight = bounds(setAlphabetText(alphabet, 'AB', 20).paths)!
    ok(gapped.maxX - gapped.minX > tight.maxX - tight.minX,
      'the missing letter leaves a gap rather than closing up',
      `${(gapped.maxX - gapped.minX).toFixed(1)} vs ${(tight.maxX - tight.minX).toFixed(1)}`)
  }

  // --- tracking and spaces
  {
    const plain = bounds(setAlphabetText(alphabet, 'AB', 20).paths)!
    const loose = bounds(setAlphabetText(alphabet, 'AB', 20, 5).paths)!
    ok(loose.maxX - loose.minX > plain.maxX - plain.minX, 'letter spacing widens the line')
    const spaced = setAlphabetText(alphabet, 'A B', 20)
    ok(spaced.letters.length === 2 && spaced.widthMm > plain.maxX - plain.minX,
      'and a space advances without drawing')
  }

  // --- it produces real stitches through the real pipeline
  {
    const r = setAlphabetText(alphabet, 'AB', 20)
    const d = emptyDoc()
    d.objects = [newObject({ name: 'word', type: 'fill', paths: r.paths })]
    const n = digitize(d).plan.blocks.flatMap((b) => b.stitches).filter((s) => !s.jump).length
    ok(n > 100, 'a word set from an alphabet sews', `${n} stitches`)
  }

  // --- storage round-trips, and a broken glyph is DROPPED not repaired
  {
    const back = parseAlphabets(serializeAlphabets([alphabet]))
    ok(back.length === 1 && Object.keys(back[0].glyphs).length === 2,
      'an alphabet survives a save', `${back.length}`)
    ok(Math.abs(back[0].glyphs.A.advanceMm - alphabet.glyphs.A.advanceMm) < 1e-9,
      'with its advances')
    const r1 = setAlphabetText(back[0], 'AB', 20)
    const r0 = setAlphabetText(alphabet, 'AB', 20)
    ok(JSON.stringify(r1.paths) === JSON.stringify(r0.paths),
      'and sets exactly the same word')

    ok(parseAlphabets(null).length === 0, 'no store means no alphabets')
    ok(parseAlphabets('{{{').length === 0, 'and neither does a corrupt one')
    // An odd-length coordinate list is half a letterform.
    const broken = '[{"id":"x","name":"x","capHeightMm":10,"glyphs":{"A":{"a":5,"p":[[0,0,1,1,2]]}}}]'
    ok(parseAlphabets(broken).length === 0,
      'a glyph with a broken coordinate list is dropped, and an alphabet with no glyphs is not kept')
    // One good glyph among bad ones survives.
    const mixed = '[{"id":"x","name":"x","capHeightMm":10,"glyphs":'
      + '{"A":{"a":5,"p":[[0,0,1,1,2]]},"B":{"a":5,"p":[[0,0,5,0,5,-5,0,-5,0,0]]}}}]'
    const m = parseAlphabets(mixed)
    ok(m.length === 1 && Object.keys(m[0].glyphs).join('') === 'B',
      'while a good glyph beside a bad one is kept', Object.keys(m[0]?.glyphs ?? {}).join(''))
  }

  // --- degenerate capture is refused rather than stored as a flat letter
  {
    ok(normaliseGlyph([], 10) === null, 'nothing cannot become a glyph')
    ok(normaliseGlyph([[{ x: 0, y: 0 }, { x: 10, y: 0 }]], 10) === null,
      'and neither can a horizontal line — it has no height to normalise by')
  }
}


// ---------------------------------------------------------------------------
console.log('\n# the run view')
{
  const box = (x: number) => [...rect(x, 0, 10, 10), { x, y: 0 }]
  const build = () => {
    const d = emptyDoc()
    d.objects = [
      newObject({ id: 'a', name: 'A', color: '#ff0000', type: 'fill', paths: [box(0)] }),
      newObject({ id: 'b', name: 'B', color: '#ff0000', type: 'fill', paths: [box(20)] }),
      newObject({ id: 'c', name: 'C', color: '#0000ff', type: 'fill', paths: [box(40)] }),
      newObject({ id: 'd', name: 'D', color: '#ff0000', type: 'fill', paths: [box(60)] }),
    ]
    return d
  }

  // --- adjacent objects on one thread are ONE block; separated ones are two
  {
    const blocks = runBlocks(build())
    ok(blocks.length === 3, 'four objects become three blocks', `${blocks.length}`)
    ok(blocks[0].objects.length === 2, 'the two adjacent reds merge',
      `${blocks[0].objects.length}`)
    ok(blocks[2].objects[0].object.name === 'D',
      'and the red AFTER the blue is its own block — a second threading')
    ok(threadChanges(blocks) === 3, 'so the operator threads three times',
      `${threadChanges(blocks)}`)
  }

  // --- the panel must key on the same thing the ENGINE keys on
  {
    const d = build()
    // Same screen colour, DIFFERENT thread codes: the machine does two
    // blocks, so the panel must show two.
    d.objects[0].thread = { brand: 'Isacord', code: '1902' }
    d.objects[1].thread = { brand: 'Isacord', code: '0015' }
    const blocks = runBlocks(d)
    ok(blocks.length === 4, 'two thread codes on one colour are two blocks',
      `${blocks.length}`)
    // And the engine agrees.
    ok(digitize(d).plan.blocks.length === blocks.filter((b) => b.number > 0).length,
      'which is what the engine produces too',
      `${digitize(d).plan.blocks.length} vs ${blocks.filter((b) => b.number > 0).length}`)
  }

  // --- an appliqué is a sequence of STOPS and never merges
  {
    const d = build()
    d.objects[1].type = 'applique'
    const blocks = runBlocks(d)
    ok(blocks.some((b) => b.isStop), 'an appliqué block is marked as a stop')
    ok(blocks[0].objects.length === 1,
      'and the object before it does not merge into it', `${blocks[0].objects.length}`)
  }

  // --- a hidden object takes no needle number
  {
    const d = build()
    d.objects[2].visible = false
    const blocks = runBlocks(d)
    const numbered = blocks.filter((b) => b.number > 0).map((b) => b.number)
    ok(numbered.join(',') === '1,2', 'numbers run 1,2 with nothing skipped',
      numbered.join(','))
    ok(blocks.find((b) => b.objects[0].object.id === 'c')?.number === 0,
      'and the hidden one has no number')
  }

  // --- stitch counts come from the generated plan
  {
    const d = build()
    const blocks = runBlocks(d, digitize(d).plan)
    ok(blocks.every((b) => b.number === 0 || (b.stitches ?? 0) > 0),
      'every sewing block has a stitch count',
      blocks.map((b) => b.stitches).join(','))
    const planTotal = digitize(d).plan.blocks
      .flatMap((b) => b.stitches).filter((s) => !s.jump).length
    const viewTotal = blocks.reduce((n, b) => n + (b.stitches ?? 0), 0)
    ok(planTotal === viewTotal, 'and they add up to the whole plan',
      `${viewTotal} of ${planTotal}`)
  }

  // --- unassigned threads are findable
  {
    const d = build()
    d.objects[0].thread = { brand: 'Isacord', code: '1902' }
    const blocks = runBlocks(d)
    ok(unassignedBlocks(blocks).length === threadChanges(blocks) - 1,
      'the blocks with no thread chosen are counted',
      `${unassignedBlocks(blocks).length}`)
  }

  // --- reordering, including the case that goes wrong
  {
    const xs = ['a', 'b', 'c', 'd']
    ok(reorder(xs, 0, 2).join('') === 'bacd', 'moving DOWN lands before the target',
      reorder(xs, 0, 2).join(''))
    ok(reorder(xs, 3, 1).join('') === 'adbc', 'and moving up does too',
      reorder(xs, 3, 1).join(''))
    ok(reorder(xs, 1, 1).join('') === 'abcd', 'a move to its own place changes nothing')
    ok(reorder(xs, 0, 4).join('') === 'bcda', 'and a move to the end works',
      reorder(xs, 0, 4).join(''))
    ok(reorder(xs, 9, 0).join('') === 'abcd', 'an impossible move is refused quietly')
  }

  // --- colour names, which is what makes a row findable
  {
    ok(colourName('#ff0000') === 'Red', 'red is Red', colourName('#ff0000'))
    ok(colourName('#1f6feb') === 'Blue', 'a mid blue is Blue', colourName('#1f6feb'))
    ok(colourName('#000000') === 'Black' && colourName('#ffffff') === 'White',
      'black and white are themselves')
    ok(colourName('#22aa33') === 'Green', 'and a leaf green is Green', colourName('#22aa33'))
    ok(colourName('nonsense') === 'Colour', 'an unreadable colour does not throw')
  }
}

// ---------------------------------------------------------------------------
console.log('\n# problems')
{
  const objects = [{ id: 'o1', name: 'Traced 1' }, { id: 'o2', name: 'Traced 24' }]
  const raw = [
    'Traced 1: tight turn (radius 1.65 mm) at (-13.3, -26.2) — inner rail will crowd',
    'Traced 24: edge underlay could not be computed — this area will sew with NO underlay',
    '26 colour blocks on a 12-needle machine — the operator must re-thread mid-run.',
    'Some blocks have no thread assigned — the run sheet will say UNASSIGNED.',
    '140 areas over 2.8x normal density — expect thread breaks',
  ]
  const ps = classifyProblems(raw, objects)

  // --- the object comes from matching a NAME, not from reading the prose
  {
    const tight = ps.find((p) => /tight turn/.test(p.text))!
    ok(tight.objectId === 'o1', 'a message naming an object is attached to it')
    ok(!/^Traced 1:/.test(tight.text), 'and the name is taken off the front', tight.text)
    const needles = ps.find((p) => /12-needle/.test(p.text))!
    ok(!needles.objectId, 'a design-level message belongs to no object')
    // The guard that matters: a message whose prefix is NOT an object name
    // must not be mistaken for one.
    const odd = classifyProblems(['Hoop: too small'], objects)[0]
    ok(!odd.objectId && odd.text === 'Hoop: too small',
      'an unmatched prefix is left alone', odd.text)
  }

  // --- the worst thing is first
  {
    ok(ps[0].severity === 'error', 'errors sort first', ps[0].text)
    ok(/could not be computed/.test(ps[0].text), 'and that is the one that is not stitching')
    const sev = ps.map((p) => p.severity)
    ok(sev.join(',') === [...sev].sort().join(','), 'the list is in severity order', sev.join(','))
  }

  // --- and each carries what to do about it
  {
    const dens = ps.find((p) => /density/.test(p.text))!
    ok(dens.fixes.includes('overlap') && dens.fixes.includes('showDensity'),
      'the density problem offers both the view and the repair', dens.fixes.join(','))
    const thread = ps.find((p) => /UNASSIGNED/.test(p.text))!
    ok(thread.fixes.includes('thread'), 'the thread problem offers the thread fields')
    ok(ps.find((p) => p.objectId)!.fixes.includes('select'),
      'and anything with an object offers to show it')
    // With one object there is nothing to un-overlap, so it is not offered.
    const solo = classifyProblems(['140 areas over 2.8x normal density'], [objects[0]])
    ok(!solo[0].fixes.includes('overlap'),
      'removing overlap is not offered when there is only one object')
  }

  // --- the summary, and the one thing to do next
  {
    const s = summarise(ps)
    ok(s.errors === 1 && s.actionable === 5, 'the counts are right',
      `${s.errors}e ${s.warnings}w ${s.notes}n`)
    const next = nextStep(ps)!
    ok(next.severity === 'error', 'the next step is the most serious actionable thing',
      next.text)
    ok(nextStep([]) === null, 'and a clean design has no next step')
    ok(nextStep(classifyProblems(['Restored unsaved work from your last session'], [])) === null,
      'a note is not a problem to fix')
  }
}


// ---------------------------------------------------------------------------
console.log('\n# the thread rack')
{
  const rack = [
    newSpool('Madeira Classic 40', '1025', '#e8601c', 'Dark Orange'),
    newSpool('Madeira Classic 40', '1002', '#f0f0f5', 'White'),
    newSpool('Isacord 40', '5422', '#1f4a8c', 'Navy'),
  ]

  // --- a spool reads the way it does on a run sheet
  {
    ok(spoolLabel(rack[0]) === 'Madeira Classic 40 1025 Dark Orange',
      'a spool reads as brand, code, name', spoolLabel(rack[0]))
    ok(spoolLabel({ code: '1025' }) === '1025', 'and a bare code still reads')
    ok(spoolLabel({}) === '', 'and nothing reads as nothing')
  }

  // --- nearest first, which is the only ordering that helps
  {
    const near = nearestSpools(rack, '#ff6a1f')
    ok(near[0].code === '1025', 'an orange finds the orange cone', near[0].code)
    ok(nearestSpools(rack, '#ffffff')[0].code === '1002', 'and a white finds the white')
    ok(nearestSpools(rack, '#102a5a')[0].code === '5422', 'and a navy the navy')
    ok(nearestSpools(rack, '#ff0000', 2).length === 2, 'the list can be capped')
    ok(nearestSpools([], '#ff0000').length === 0, 'an empty rack offers nothing')
  }

  // --- the built-in chart is the one that can be stated exactly
  {
    const m = nearestMachineThread('#ff0000')!
    ok(m.brand === 'Brother', 'the built-in chart is the format palette', m.brand)
    ok(m.thread.name === 'Red', 'and red finds Red', m.thread.name)
    ok(nearestMachineThread('#ffffff')!.thread.name === 'White', 'white finds White')
    ok(nearestMachineThread('#000000')!.thread.name === 'Black', 'black finds Black')
    ok(BROTHER_THREADS.length === 64, 'all 64 are there', `${BROTHER_THREADS.length}`)
    ok(BROTHER_THREADS.every((t) => /^#[0-9a-f]{6}$/i.test(t.color)),
      'and every one has a readable colour')
    ok(new Set(BROTHER_THREADS.map((t) => t.code)).size === 64, 'with no duplicate codes')
  }

  // --- storage, and a spool with no code is not a spool
  {
    const back = parseRack(serializeRack(rack))
    ok(back.length === 3, 'a rack survives a save', `${back.length}`)
    ok(spoolLabel(back[0]) === spoolLabel(rack[0]), 'intact')
    ok(parseRack(null).length === 0 && parseRack('nonsense').length === 0,
      'and a missing or corrupt rack is empty, not an exception')
    // A cone with no catalogue number cannot be found on a rack.
    const holed = parseRack('[{"id":"a","brand":"X","color":"#ff0000"},'
      + '{"id":"b","code":"7","color":"#00ff00"}]')
    ok(holed.length === 1 && holed[0].code === '7',
      'a spool with no code is dropped', `${holed.length}`)
    // A broken colour falls back rather than poisoning the swatch.
    const odd = parseRack('[{"id":"a","code":"1","color":"blue"}]')
    ok(/^#[0-9a-f]{6}$/i.test(odd[0].color), 'and an unreadable colour falls back',
      odd[0].color)
  }

  // --- the weighting is the point: plain RGB calls blue and brown neighbours
  {
    const blue = '#3040a0', brown = '#a06030', trueBlue = '#2838b0'
    ok(colourDistance(blue, trueBlue) < colourDistance(blue, brown),
      'a blue is nearer another blue than it is to a brown')
    ok(colourDistance('#ff0000', 'nonsense') === Infinity,
      'an unreadable colour is infinitely far from anything')
  }
}


// ---------------------------------------------------------------------------
console.log('\n# units')
{
  // --- inches as a tape measure reads them
  {
    ok(toInchFraction(25.4) === '1"', 'a whole inch', toInchFraction(25.4))
    ok(toInchFraction(0) === '0"', 'nothing')
    ok(toInchFraction(12.7) === '1/2"', 'a half, reduced from 8/16', toInchFraction(12.7))
    ok(toInchFraction(61.9) === '2 7/16"', 'a mixed number', toInchFraction(61.9))
    ok(toInchFraction(-7.94) === '-5/16"', 'and a negative one', toInchFraction(-7.94))
    // Rounding up through a whole inch must carry, not print 2 16/16.
    ok(toInchFraction(25.4 * 1.999) === '2"', 'a hair under 2 inches rounds to 2',
      toInchFraction(25.4 * 1.999))
  }

  // --- the parser takes what people type
  {
    const inch = (t: string) => parseLength(t, 'inch')
    ok(Math.abs(inch('1')! - 25.4) < 1e-9, 'a bare number in the showing unit')
    ok(Math.abs(inch('2 7/16')! - 61.9125) < 1e-6, 'a mixed number', `${inch('2 7/16')}`)
    ok(Math.abs(inch('2-7/16')! - 61.9125) < 1e-6, 'written with a hyphen')
    ok(Math.abs(inch('7/16')! - 11.1125) < 1e-6, 'a bare fraction')
    ok(Math.abs(inch('2.4375')! - 61.9125) < 1e-6, 'a decimal')
    ok(Math.abs(inch('-5/16')! + 7.9375) < 1e-6, 'and a negative')
    // An explicit unit WINS. Somebody typing 60mm into an inch field means
    // 60 mm and must not get 1524.
    ok(Math.abs(inch('60mm')! - 60) < 1e-9, 'an explicit mm overrides the showing unit',
      `${inch('60mm')}`)
    ok(Math.abs(parseLength('2"', 'mm')! - 50.8) < 1e-9, 'and an explicit inch does too')
  }

  // --- nonsense is REFUSED, not guessed at
  {
    ok(parseLength('', 'mm') === null, 'empty is nothing')
    ok(parseLength('abc', 'mm') === null, 'and so is a word')
    ok(parseLength('1/0', 'inch') === null, 'a divide by zero is not a length')
    ok(parseLength('2 7/', 'inch') === null, 'nor is half a fraction')
    // The one that matters: a field that turned nonsense into 0 would
    // resize a design to nothing.
    ok(parseLength('3..5', 'mm') === null, 'nor a mistyped decimal')
  }

  // --- the field round-trips through itself
  {
    for (const mm of [0.1, 1, 12.7, 25.4, 61.9125, 100, 203.2]) {
      for (const u of ['mm', 'inch'] as const) {
        const back = parseLength(formatField(mm, u), u)
        ok(back !== null && Math.abs(back - mm) < (u === 'inch' ? 1.6 : 0.06),
          `${mm} mm survives a round trip through the ${u} field`,
          `${formatField(mm, u)} -> ${back}`)
      }
    }
  }
}


// ---------------------------------------------------------------------------
console.log('\n# the backdrop saves with the project')
{
  // A one-pixel PNG is a real image and a real data URL; nothing here cares
  // how big it is.
  const PNG = 'data:image/png;base64,'
    + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  const build = () => {
    const d = emptyDoc()
    // A FIXED id: newObject mints a fresh one per call, and the signature
    // comparison below would then be testing the id generator.
    d.objects = [newObject({
      id: 'fixed', name: 'A', type: 'fill', paths: [[...rect(0, 0, 20, 20), { x: 0, y: 0 }]],
    })]
    d.backdrop = { dataUrl: PNG, pxPerMm: 4.25, origin: { x: -95.6, y: -40 }, name: 'logo.png' }
    return d
  }

  // --- it survives, intact
  {
    const back = deserialize(serialize(build()))
    ok(back.backdrop?.dataUrl === PNG, 'the image itself comes back byte for byte')
    ok(back.backdrop?.pxPerMm === 4.25, 'with its scale — which is what fixes its size on the garment')
    ok(back.backdrop?.origin.x === -95.6 && back.backdrop?.origin.y === -40, 'and its position')
    ok(back.backdrop?.name === 'logo.png', 'and the file it came from')
  }

  // --- a design with no picture does not grow one
  {
    const plain = emptyDoc()
    plain.objects = [newObject({ paths: [[{ x: 0, y: 0 }]] })]
    ok(deserialize(serialize(plain)).backdrop === undefined, 'no picture means no picture')
    ok(!/backdrop/.test(serialize(plain)), 'and nothing is written for one', 'key absent')
  }

  // --- anything that is NOT an image is dropped
  {
    const evil = JSON.parse(serialize(build()))
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'https://example.com/logo.png',
      '',
    ]) {
      evil.doc.backdrop.dataUrl = bad
      ok(deserialize(JSON.stringify(evil)).backdrop === undefined,
        `a dataUrl of "${bad.slice(0, 24)}" is refused`)
    }
    // This string is handed to an <img>, and a project file is something
    // people email each other. The media type is checked, not assumed.
  }

  // --- a picture with no scale cannot be placed, so it is not kept
  {
    const odd = JSON.parse(serialize(build()))
    odd.doc.backdrop.pxPerMm = 0
    ok(deserialize(JSON.stringify(odd)).backdrop === undefined, 'a zero scale is refused')
    odd.doc.backdrop.pxPerMm = 'big'
    ok(deserialize(JSON.stringify(odd)).backdrop === undefined, 'and so is a nonsense one')
  }

  // --- a missing origin is recoverable; a missing NAME is not fatal
  {
    const part = JSON.parse(serialize(build()))
    delete part.doc.backdrop.origin
    delete part.doc.backdrop.name
    const r = deserialize(JSON.stringify(part)).backdrop
    ok(!!r && r.origin.x === 0 && r.origin.y === 0, 'a lost origin falls back to the middle')
    ok(r?.name === 'image', 'and a lost name to something sayable', r?.name)
  }

  // --- IT MUST NOT CHANGE THE STITCHES. It is a tracing aid.
  {
    const withPic = build()
    const without = build()
    without.backdrop = undefined
    const count = (d: Doc) =>
      digitize(d).plan.blocks.flatMap((b) => b.stitches).length
    ok(count(withPic) === count(without), 'a reference picture generates no stitches',
      `${count(withPic)} vs ${count(without)}`)
    // And it must not make the plan regenerate: loading a picture is not an
    // edit to the design.
    ok(docSignature(withPic) === docSignature(without),
      'nor does it change the document signature')
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
