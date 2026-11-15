// Render a fixture's stitch plan to an SVG, so a design can be LOOKED AT.
//
// A stitch count and a bounds check pass on a band that has twisted into a
// starburst — that defect was found by looking, not by a test, and the test
// that now guards it was written afterwards. This exists so looking is cheap.
//
//   npx tsx scripts/render-fixture.mts sampler
import { readFileSync, writeFileSync } from 'node:fs'

const name = process.argv[2]
if (!name) { console.error('usage: render-fixture.mts <fixture-name>'); process.exit(1) }
const d = JSON.parse(readFileSync(`fixtures/${name}.intended.json`, 'utf8'))
const pts: [number, number][] = d.penetrations
const pad = 6
const w = d.widthMm + pad * 2, h = d.heightMm + pad * 2
const ox = -d.minXmm + pad, oy = -d.minYmm + pad

// Long hops are travel, not stitching. Drawing them joined makes a design
// look like a cat's cradle and hides what the stitching actually does.
//
// The threshold has to sit ABOVE the sewn-stitch cap, not at the travel-trim
// distance: a lace mesh thread is a legitimate 10 mm stitch, and a 6 mm
// threshold erased the entire mesh from the picture while leaving its border,
// which looked exactly like a mesh that had failed to generate.
const TRAVEL_MM = 10.5
let path = ''
let prev: [number, number] | null = null
for (const [x, y] of pts) {
  const X = (x + ox).toFixed(2), Y = (y + oy).toFixed(2)
  const far = prev && Math.hypot(x - prev[0], y - prev[1]) > TRAVEL_MM
  path += !prev || far ? ` M${X},${Y}` : ` L${X},${Y}`
  prev = [x, y]
}
writeFileSync(`fixtures/${name}.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" width="${(w * 4).toFixed(0)}" height="${(h * 4).toFixed(0)}" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}">
<rect width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="#111"/>
<path d="${path}" fill="none" stroke="#e8e8e8" stroke-width="0.22" stroke-linecap="round"/>
</svg>`)
console.log(`fixtures/${name}.svg — ${pts.length} penetrations, ${d.widthMm} x ${d.heightMm} mm`)
