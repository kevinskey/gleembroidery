// Validate the DST codec against real-world files.
//
// The header's ST/+X/-X/+Y/-Y were written by whatever package made the
// file. Decoding the records and arriving at the SAME numbers independently
// confirms the record bit table, the axis signs and the 0.1 mm scale. A
// wrong bit would move the extents; a wrong Y sign would swap +Y and -Y.
//
//   npx tsx scripts/verify-dst.mts <file.dst> [...]

import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { readDst, writeDst } from '../src/dst'
import type { StitchPlan } from '../src/stitches'

const files = process.argv.slice(2)
if (!files.length) {
  // Exiting 0 here printed "all checks passed" while validating nothing —
  // a green light for a codec that had never seen another package's output.
  console.error('verify-dst: no files given. Pass one or more .dst files to validate.')
  console.error('usage: npm run verify:dst -- <file.dst> [...]')
  process.exit(2)
}

let failures = 0

function check(label: string, got: number, want: number, tol = 0) {
  const ok = Math.abs(got - want) <= tol
  if (!ok) failures++
  return `${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(14)} got ${String(got).padStart(7)}  header ${String(want).padStart(7)}`
}

for (const file of files) {
  const bytes = new Uint8Array(readFileSync(file))
  const d = readDst(bytes)
  console.log(`\n=== ${basename(file)} (${bytes.length} bytes) ===`)
  console.log(`  header: ${JSON.stringify(d.header)}`)
  console.log(
    `  decoded: ${d.stitchCount} stitches, ${d.jumpCount} jumps, ${d.colorChanges} colour changes, ` +
      `${(d.extents.maxX - d.extents.minX).toFixed(1)} x ${(d.extents.maxY - d.extents.minY).toFixed(1)} mm`,
  )

  const h = (k: string) => parseInt(d.header[k] ?? 'NaN', 10)
  // ST counts every record including jumps and the end record, by convention.
  if (!Number.isNaN(h('ST')))
    console.log('  ' + check('ST', d.stitchCount + d.jumpCount + d.colorChanges + 1, h('ST'), 2))
  if (!Number.isNaN(h('CO'))) console.log('  ' + check('CO', d.colorChanges, h('CO'), 0))
  if (!Number.isNaN(h('+X'))) console.log('  ' + check('+X', Math.round(d.extents.maxX * 10), h('+X'), 1))
  if (!Number.isNaN(h('-X'))) console.log('  ' + check('-X', Math.round(-d.extents.minX * 10), h('-X'), 1))
  // header +Y is UP-positive; decoded maxY is DOWN-positive, so they swap.
  if (!Number.isNaN(h('+Y'))) console.log('  ' + check('+Y', Math.round(-d.extents.minY * 10), h('+Y'), 1))
  if (!Number.isNaN(h('-Y'))) console.log('  ' + check('-Y', Math.round(d.extents.maxY * 10), h('-Y'), 1))

  // Round trip: re-encode exactly what we decoded and decode again. Every
  // absolute position must come back identical.
  const plan: StitchPlan = {
    blocks: d.blocks.map((b, i) => ({ color: '#000000', label: `c${i}`, stitches: b.stitches })),
  }
  const again = readDst(writeDst(plan, 'roundtrip'))
  // Compare NEEDLE PENETRATIONS, not records. Re-encoding deliberately adds
  // a trim before every colour change, and a travel past one record's reach
  // splits into several jumps — both change the record count while leaving
  // every place the needle goes down identical. That is the real invariant.
  const pen = (s: { jump?: boolean }[]) => s.filter((q) => !q.jump)
  const a = pen(d.blocks.flatMap((b) => b.stitches)) as { x: number; y: number }[]
  const c = pen(again.blocks.flatMap((b) => b.stitches)) as { x: number; y: number }[]
  let worst = 0
  for (let i = 0; i < Math.min(a.length, c.length); i++)
    worst = Math.max(worst, Math.abs(a[i].x - c[i].x), Math.abs(a[i].y - c[i].y))
  const rtOk = a.length === c.length && worst < 1e-9
  if (!rtOk) failures++
  console.log(
    `  ${rtOk ? 'ok  ' : 'FAIL'} round-trip   ${a.length} -> ${c.length} penetrations, max drift ${worst.toFixed(4)} mm`,
  )
}

if (process.env.DUMP) {
  // Smoke file: a 40 mm square outline, to eyeball in any viewer.
  const pts = [
    { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }, { x: 0, y: 0 },
  ]
  writeFileSync('square.dst', writeDst({ blocks: [{ color: '#000', label: 'sq', stitches: pts }] }, 'square'))
  console.log('\nwrote square.dst')
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
