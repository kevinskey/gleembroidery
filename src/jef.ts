// Janome JEF — write.
//
// A real header this time: an offset to the stitch data, a date, a stitch
// count, a hoop code, four sets of hoop-edge distances, and a thread palette.
// The stitch encoding itself is as simple as EXP's.
//
// HEADER (little-endian 32-bit unless noted)
//   0x00  offset to stitch data
//   0x04  0x14
//   0x08  date, 14 ASCII bytes "YYYYMMDDHHMMSS"
//   0x16  two zero bytes
//   0x18  colour count (colour changes + 1)
//   0x1C  command count, including the end command
//   0x20  hoop code
//   0x24  design extents and hoop-edge distances, 0x50 bytes
//   0x74  colour-count palette indices, then colour-count copies of 0x0D
//
// RECORD ENCODING
//   dx dy             a normal stitch, signed bytes, 0.1 mm units
//   0x80 0x02 dx dy   jump
//   0x80 0x01 dx dy   colour change
//   0x80 0x10         end
//
// THREAD COLOURS ARE NOT FREE. JEF stores an INDEX into Janome's built-in
// thread table, not an RGB value, so a design's colours are snapped to the
// nearest of 78 — which is the format's limitation, not an approximation
// anyone here chose, and the export says so rather than implying the colours
// survive.

import type { StitchPlan } from './stitches'
import { moveBounds, planColors, planToMoves, splitMove } from './machine'

/** Largest move one JEF record can express, in 0.1 mm units. */
export const JEF_MAX_STEP = 127

/**
 * Janome's built-in thread table, as RGB.
 *
 * Index 0 is unused by the machine and is never selected here. The rest is
 * the table a JEF reader will look a design's colours up in; it is quoted
 * rather than derived, so it must not be "tidied".
 */
export const JEF_PALETTE: number[] = [
  0x000000, 0x000000, 0xffffff, 0xffff17, 0xff6600, 0x2f5933, 0x237336, 0x65c2c8,
  0xab5a96, 0xf669a0, 0xff0000, 0xb1704e, 0x0b2f84, 0xe4c35d, 0x481a05,
  0xac9cc7, 0xfcf294, 0xf999b7, 0xfab381, 0xc9a480, 0x970533, 0xa0b8cc,
  0x7fc21c, 0xe5e5e5, 0x889b9b, 0x98d6bd, 0xb2e1e3, 0x368ba0, 0x4f83ab,
  0x386a91, 0x071650, 0xf999a2, 0xf9676b, 0xe3311f, 0xe2a188, 0xb59474,
  0xe4cf99, 0xffcb00, 0xe1add4, 0xc3007e, 0x80004b, 0x540571, 0xb10525,
  0xcae0c0, 0x899856, 0x5c941a, 0x003114, 0x5dae94, 0x4cbf8f, 0x007772,
  0x595b61, 0xfffff2, 0xb15818, 0xcb8a07, 0x986c80, 0x98692d, 0x4d3419,
  0x4c330b, 0x33200a, 0x523a97, 0x0d217e, 0x1e77ac, 0xb2dd53, 0xf33689,
  0xde649e, 0x984161, 0x4c5612, 0x4c881f, 0xe4de79, 0xcb8a1a, 0xcba21c,
  0xff9805, 0xfcb257, 0xffe505, 0xf0331f, 0x1a842d, 0x386cae, 0xe3c4b4,
  0xe3ac81,
]

/** Nearest palette index to an '#rrggbb' colour. Index 0 is never chosen. */
export function nearestJefColor(hex: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  // An unparseable colour becomes black rather than throwing: a design still
  // has to export, and the operator can see on the run sheet what thread was
  // meant.
  if (!m) return 1
  const v = parseInt(m[1], 16)
  const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff
  let best = 1, bestD = Infinity
  for (let i = 1; i < JEF_PALETTE.length; i++) {
    const c = JEF_PALETTE[i]
    const d = (((c >> 16) & 0xff) - r) ** 2 + (((c >> 8) & 0xff) - g) ** 2 + ((c & 0xff) - b) ** 2
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

/** Janome hoop codes, chosen from the design's own size. */
function hoopCode(widthUnits: number, heightUnits: number): number {
  if (widthUnits < 500 && heightUnits < 500) return 1 // 50x50
  if (widthUnits < 1260 && heightUnits < 1100) return 3 // 126x110
  if (widthUnits < 1400 && heightUnits < 2000) return 2 // 140x200
  if (widthUnits < 2000 && heightUnits < 2000) return 4 // 200x200
  return 0 // 110x110
}

/**
 * Write a JEF.
 *
 * `date` is injectable so a test can produce a byte-identical file twice.
 * Left to a clock, two exports of the same design differ, and then "the file
 * changed" stops meaning anything.
 */
export function writeJef(plan: StitchPlan, date = new Date()): Uint8Array {
  const moves = planToMoves(plan)
  const colors = planColors(plan)
  const colorCount = Math.max(1, colors.length)
  const palette = colors.map(nearestJefColor)
  while (palette.length < colorCount) palette.push(1)

  // --- stitch data first, so the counts in the header are measured rather
  //     than predicted. A header that disagrees with the data is the classic
  //     way a file loads and then sews short.
  const body: number[] = []
  let curX = 0, curY = 0
  // Machine-frame deltas: planToMoves has already flipped the document's
  // +Y-down to the machine's +Y-up. See the note in exp.ts.
  const byte = (v: number) => v & 0xff
  let commands = 0

  const emitStitch = (x: number, y: number) => {
    body.push(byte(x - curX), byte(y - curY))
    curX = x; curY = y
    commands++
  }
  const emitJump = (x: number, y: number) => {
    body.push(0x80, 0x02, byte(x - curX), byte(y - curY))
    curX = x; curY = y
    commands += 2
  }

  for (const m of moves) {
    switch (m.kind) {
      case 'stitch':
        for (const p of splitMove(curX, curY, m.x, m.y, JEF_MAX_STEP)) emitStitch(p.x, p.y)
        break
      case 'jump':
        for (const p of splitMove(curX, curY, m.x, m.y, JEF_MAX_STEP)) emitJump(p.x, p.y)
        break
      case 'trim':
        // JEF's trim is a repeated command; one is routinely filtered as
        // noise, so the convention is three.
        for (let i = 0; i < 3; i++) { body.push(0x80, 0x02, 0x00, 0x00); commands += 2 }
        for (const p of splitMove(curX, curY, m.x, m.y, JEF_MAX_STEP)) emitJump(p.x, p.y)
        break
      case 'color':
        // THE COLOUR-CHANGE RECORD CARRIES NO MOVEMENT.
        //
        // The format has room for a displacement and readers discard it —
        // pyembroidery reads the two bytes and throws them away. Encoding the
        // travel there meant every stitch after the first colour change was
        // offset by however far the next block started from the last one:
        // 39 mm on one fixture, and a design that opens, looks plausible and
        // sews the second colour in the wrong place.
        //
        // So the stop is written in place, and the travel to the next block
        // follows as an ordinary jump.
        body.push(0x80, 0x01, 0x00, 0x00)
        commands += 2
        for (const p of splitMove(curX, curY, m.x, m.y, JEF_MAX_STEP)) emitJump(p.x, p.y)
        break
    }
  }
  body.push(0x80, 0x10) // end
  commands++

  // --- header
  const b = moveBounds(moves)
  const width = b.maxX - b.minX
  const height = b.maxY - b.minY
  const halfW = Math.round(width / 2)
  const halfH = Math.round(height / 2)

  const head: number[] = []
  const u32 = (v: number) => {
    head.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff)
  }
  const offset = 0x74 + colorCount * 8
  u32(offset)
  u32(0x14)
  const two = (n: number) => String(n).padStart(2, '0')
  const stamp = `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`
    + `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
  for (const ch of stamp) head.push(ch.charCodeAt(0) & 0xff)
  head.push(0, 0)
  u32(colorCount)
  u32(commands)
  u32(hoopCode(width, height))

  // Design extents as distances from the centre of the hoop.
  u32(halfW); u32(halfH); u32(halfW); u32(halfH)
  // Distances to the edge of each standard hoop. A negative distance means
  // the design does not fit that hoop, and the format's way of saying so is
  // four -1s rather than a negative measurement.
  const edges: [number, number][] = [[550, 550], [250, 250], [700, 1000], [700, 1000]]
  for (const [ex, ey] of edges) {
    const x = ex - halfW, y = ey - halfH
    if (Math.min(x, y) >= 0) { u32(x); u32(y); u32(x); u32(y) }
    else { u32(-1); u32(-1); u32(-1); u32(-1) }
  }
  for (const p of palette) u32(p)
  for (let i = 0; i < colorCount; i++) u32(0x0d)

  const out = new Uint8Array(head.length + body.length)
  out.set(Uint8Array.from(head), 0)
  out.set(Uint8Array.from(body), head.length)
  return out
}
