// Tajima DST — read and write.
//
// DST is what the BAI reads, and what every other machine and every
// digitizing package will also take. It stores nothing but needle moves:
// no colours, no object structure. Colour CHANGES are recorded, so an
// n-colour design survives as n blocks the operator threads by hand.
//
// FILE SHAPE
//   bytes 0..511   ASCII header, CR-terminated fields, 0x1A then spaces
//   bytes 512..    3-byte stitch records
//   last record    0x00 0x00 0xF3
//
// RECORD ENCODING
// Each record carries a RELATIVE move in 0.1 mm units, as a sum of signed
// powers-of-three-ish steps (1, 3, 9, 27, 81) spread over the three bytes,
// which is why the reachable range is ±121 (1+3+9+27+81) per axis per
// record. Anything longer must be split across records.
//
//   byte0  b7 y+1  b6 y-1  b5 y+9  b4 y-9  b3 x-9  b2 x+9  b1 x-1  b0 x+1
//   byte1  b7 y+3  b6 y-3  b5 y+27 b4 y-27 b3 x-27 b2 x+27 b1 x-3  b0 x+3
//   byte2  b7 jmp  b6 stop b5 y+81 b4 y-81 b3 x-81 b2 x+81 b1 1    b0 1
//
// Bits 0 and 1 of byte 2 are always set on a real record. byte2 = 0x03 is a
// normal stitch, 0x83 a jump (needle up), 0xC3 a colour change, 0xF3 end.
//
// DST's +Y is UP. The document's +Y is DOWN. The flip happens here and
// nowhere else.

import type { StitchPlan } from './stitches'

const HEADER_BYTES = 512
const RECORD_BYTES = 3
/** Largest move one record can express, in 0.1 mm units. */
export const MAX_STEP = 121

export interface DstReadResult {
  /** Absolute positions in mm, Y DOWN, origin at the design's start point. */
  blocks: { stitches: { x: number; y: number; jump?: boolean }[] }[]
  header: Record<string, string>
  /** Extents in mm computed from the records themselves. */
  extents: { minX: number; minY: number; maxX: number; maxY: number }
  stitchCount: number
  jumpCount: number
  colorChanges: number
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Encode one relative move. dx/dy are in 0.1 mm units, already Y-flipped,
 * and must each be within ±MAX_STEP.
 */
function encodeRecord(dx: number, dy: number, flag: 'normal' | 'jump' | 'stop'): [number, number, number] {
  if (dx < -MAX_STEP || dx > MAX_STEP || dy < -MAX_STEP || dy > MAX_STEP)
    throw new Error(`DST move out of range: ${dx},${dy}`)
  let b0 = 0, b1 = 0, b2 = 0x03
  let x = dx, y = dy

  // Greedy from the largest step down. The thresholds are the midpoints
  // between what the remaining smaller steps can still reach and what they
  // cannot, so every value in range decomposes exactly.
  if (x > 40) { b2 |= 0x04; x -= 81 }
  if (x < -40) { b2 |= 0x08; x += 81 }
  if (x > 13) { b1 |= 0x04; x -= 27 }
  if (x < -13) { b1 |= 0x08; x += 27 }
  if (x > 4) { b0 |= 0x04; x -= 9 }
  if (x < -4) { b0 |= 0x08; x += 9 }
  if (x > 1) { b1 |= 0x01; x -= 3 }
  if (x < -1) { b1 |= 0x02; x += 3 }
  if (x > 0) { b0 |= 0x01; x -= 1 }
  if (x < 0) { b0 |= 0x02; x += 1 }
  if (x !== 0) throw new Error(`DST x residue ${x}`)

  if (y > 40) { b2 |= 0x20; y -= 81 }
  if (y < -40) { b2 |= 0x10; y += 81 }
  if (y > 13) { b1 |= 0x20; y -= 27 }
  if (y < -13) { b1 |= 0x10; y += 27 }
  if (y > 4) { b0 |= 0x20; y -= 9 }
  if (y < -4) { b0 |= 0x10; y += 9 }
  if (y > 1) { b1 |= 0x80; y -= 3 }
  if (y < -1) { b1 |= 0x40; y += 3 }
  if (y > 0) { b0 |= 0x80; y -= 1 }
  if (y < 0) { b0 |= 0x40; y += 1 }
  if (y !== 0) throw new Error(`DST y residue ${y}`)

  if (flag === 'jump') b2 |= 0x80
  else if (flag === 'stop') b2 |= 0xc0
  return [b0, b1, b2]
}

function header(name: string, stitches: number, colorChanges: number, ex: {
  plusX: number; minusX: number; plusY: number; minusY: number; ax: number; ay: number
}): Uint8Array {
  const buf = new Uint8Array(HEADER_BYTES).fill(0x20)
  // %5d / %7d fields are RIGHT-aligned and space padded; the label is left
  // aligned in 16 characters. Machines are lenient about the numbers but
  // strict about the field widths, so build them literally.
  const n5 = (v: number) => (v < 0 ? '-' : '+') + String(Math.abs(Math.round(v))).padStart(5, '0')
  const fields = [
    'LA:' + name.slice(0, 16).padEnd(16, ' '),
    'ST:' + String(stitches).padStart(7, ' '),
    'CO:' + String(colorChanges).padStart(3, ' '),
    '+X:' + String(Math.round(ex.plusX)).padStart(5, ' '),
    '-X:' + String(Math.round(ex.minusX)).padStart(5, ' '),
    '+Y:' + String(Math.round(ex.plusY)).padStart(5, ' '),
    '-Y:' + String(Math.round(ex.minusY)).padStart(5, ' '),
    'AX:' + n5(ex.ax),
    'AY:' + n5(ex.ay),
    'MX:' + n5(0),
    'MY:' + n5(0),
    'PD:******',
  ]
  let o = 0
  for (const f of fields) {
    for (let i = 0; i < f.length; i++) buf[o++] = f.charCodeAt(i)
    buf[o++] = 0x0d
  }
  buf[o++] = 0x1a
  return buf
}

/**
 * Write a stitch plan as a DST file.
 *
 * Long moves are split into as many records as the ±12.1 mm per-record reach
 * requires. A split JUMP stays a jump throughout; a split normal stitch would
 * be a stitch longer than any machine should sew, so digitize.ts is expected
 * to have broken those up already — if one survives, it is emitted as jumps
 * rather than silently sewn.
 */
export function writeDst(plan: StitchPlan, name = 'gleembroidery', trimAt = 3): Uint8Array {
  const recs: number[] = []
  // 0.1 mm machine units, DST axes (+Y up).
  let curX = 0, curY = 0
  // Extents are measured from the start point, which is the origin — the
  // reader accumulates from 0 too, so the two stay symmetric.
  let minX = 0, maxX = 0, minY = 0, maxY = 0
  let stitchCount = 0
  let colorChanges = 0

  const emit = (b: [number, number, number]) => { recs.push(b[0], b[1], b[2]); stitchCount++ }

  const moveTo = (tx: number, ty: number, flag: 'normal' | 'jump') => {
    // Interpolate from the position held when the move STARTED. Stepping from
    // the running position instead compounds the delta and overshoots.
    const sx = curX, sy = curY
    const dx = tx - sx, dy = ty - sy
    // Split into reachable chunks. Steps are taken as large as possible so a
    // long travel costs the fewest records.
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / MAX_STEP))
    // A move needing more than one record is longer than 12.1 mm — longer
    // than any machine should sew — so EVERY record of it lifts the needle,
    // the last one included. Keeping the final record "normal" is what turns
    // an approach leg into a 9.5 mm stitch dragged across the garment.
    // digitize() caps sewn stitches well below this, so for normal stitches
    // this is a backstop that should never fire.
    const effective = steps > 1 ? 'jump' : flag
    for (let i = 1; i <= steps; i++) {
      const nx = Math.round(sx + (dx * i) / steps)
      const ny = Math.round(sy + (dy * i) / steps)
      emit(encodeRecord(nx - curX, ny - curY, effective))
      curX = nx
      curY = ny
    }
    minX = Math.min(minX, curX); maxX = Math.max(maxX, curX)
    minY = Math.min(minY, curY); maxY = Math.max(maxY, curY)
  }

  // A trim has no opcode in DST. Controllers watch for a RUN of consecutive
  // jump records instead — three is the common threshold.
  //
  // Crucially, the run is the TRAVEL ITSELF split into at least three jumps,
  // not three no-op records followed by a move. A census of seven third-party
  // files (four originating packages) found 584 nonzero jump records inside
  // trim runs and exactly seven zero-delta ones — one per file, the opening
  // record. ABILITY.DST renders a 2.0 mm travel as (7,1)(6,1)(7,1) purely to
  // clear the threshold. pyembroidery's reader actively DELETES zero-delta
  // jump runs, so an optimiser that does the same would have annihilated our
  // trims and left an uncut float across the garment.
  const trimmedMoveTo = (tx: number, ty: number) => {
    const dx = tx - curX, dy = ty - curY
    const span = Math.max(Math.abs(dx), Math.abs(dy))
    const steps = Math.max(trimAt, Math.ceil(span / MAX_STEP) || 1)
    if (span === 0) {
      // Nothing to travel: pyembroidery's convention is a net-zero zig-zag,
      // which still reads as a run of real jumps.
      const z = 2
      emit(encodeRecord(z, 0, 'jump'))
      emit(encodeRecord(-z, 0, 'jump'))
      emit(encodeRecord(0, 0, 'jump'))
      return
    }
    const sx = curX, sy = curY
    for (let i = 1; i <= steps; i++) {
      const nx = Math.round(sx + (dx * i) / steps)
      const ny = Math.round(sy + (dy * i) / steps)
      emit(encodeRecord(nx - curX, ny - curY, 'jump'))
      curX = nx
      curY = ny
    }
    minX = Math.min(minX, curX); maxX = Math.max(maxX, curX)
    minY = Math.min(minY, curY); maxY = Math.max(maxY, curY)
  }

  let first = true
  plan.blocks.forEach((block, bi) => {
    if (!block.stitches.length) return
    if (bi > 0) {
      // No jump run before the colour change. In the field, colour changes
      // follow sewn stitches directly — all 34 in Hero.DST and all 3 in
      // HOME 2.DST do — because trim-on-colour-change is a machine-side
      // parameter that is normally on. Requesting it here as well asked for
      // two cuts and charged the run-time estimate for both.
      emit(encodeRecord(0, 0, 'stop'))
      colorChanges++
    }
    for (const s of block.stitches) {
      const tx = Math.round(s.x * 10)
      const ty = Math.round(-s.y * 10) // document Y down -> DST Y up
      if (s.trim) { trimmedMoveTo(tx, ty); continue }
      if (first) {
        // The needle starts at the hoop centre, nowhere near the first
        // penetration. That leg is needle-UP — sewing it drags thread across
        // the garment — and it goes out as a full jump RUN rather than the
        // one or two records the distance happens to need, so a controller
        // cannot read it as an ambiguous short hop.
        trimmedMoveTo(tx, ty)
        first = false
        continue
      }
      moveTo(tx, ty, s.jump ? 'jump' : 'normal')
    }
  })

  // Return to the origin before ending. Six of seven field files do this, and
  // all seven write AX/AY as zero: those fields are the end position relative
  // to the start, and a controller with return-to-origin disabled — or any
  // repeat/array function — applies them, so a design with a live offset
  // WALKS across the garment on each run.
  if (curX !== 0 || curY !== 0) trimmedMoveTo(0, 0)

  // End of design.
  recs.push(0x00, 0x00, 0xf3)
  stitchCount++

  const head = header(name, stitchCount, colorChanges, {
    plusX: maxX, minusX: -minX, plusY: maxY, minusY: -minY, ax: curX, ay: curY,
  })
  // Every field file ends 512 + 3n + 1 bytes, with a DOS SUB after the END
  // record. Record-driven readers do not care; USB loaders that scan for 0x1A
  // do, and it costs one byte.
  const out = new Uint8Array(HEADER_BYTES + recs.length + 1)
  out.set(head, 0)
  out.set(Uint8Array.from(recs), HEADER_BYTES)
  out[out.length - 1] = 0x1a
  return out
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function decodeRecord(b0: number, b1: number, b2: number): { dx: number; dy: number; flag: 'normal' | 'jump' | 'stop' | 'end' } {
  let dx = 0, dy = 0
  if (b0 & 0x01) dx += 1
  if (b0 & 0x02) dx -= 1
  if (b0 & 0x04) dx += 9
  if (b0 & 0x08) dx -= 9
  if (b1 & 0x01) dx += 3
  if (b1 & 0x02) dx -= 3
  if (b1 & 0x04) dx += 27
  if (b1 & 0x08) dx -= 27
  if (b2 & 0x04) dx += 81
  if (b2 & 0x08) dx -= 81
  if (b0 & 0x80) dy += 1
  if (b0 & 0x40) dy -= 1
  if (b0 & 0x20) dy += 9
  if (b0 & 0x10) dy -= 9
  if (b1 & 0x80) dy += 3
  if (b1 & 0x40) dy -= 3
  if (b1 & 0x20) dy += 27
  if (b1 & 0x10) dy -= 27
  if (b2 & 0x20) dy += 81
  if (b2 & 0x10) dy -= 81
  const flag: 'normal' | 'jump' | 'stop' | 'end' =
    b2 === 0xf3 ? 'end' : (b2 & 0xc0) === 0xc0 ? 'stop' : b2 & 0x80 ? 'jump' : 'normal'
  return { dx, dy, flag }
}

export function readDst(bytes: Uint8Array): DstReadResult {
  if (bytes.length < HEADER_BYTES + RECORD_BYTES) throw new Error('Too short to be a DST file')

  const headerText = Array.from(bytes.slice(0, HEADER_BYTES))
    .map((c) => String.fromCharCode(c))
    .join('')
  const head: Record<string, string> = {}
  for (const field of headerText.split('\r')) {
    const m = /^([+\-A-Z]{2}):(.*)$/.exec(field.trim())
    if (m) head[m[1]] = m[2].trim()
  }

  const blocks: DstReadResult['blocks'] = [{ stitches: [] }]
  let x = 0, y = 0 // 0.1 mm, DST axes
  let minX = 0, maxX = 0, minY = 0, maxY = 0
  let stitchCount = 0, jumpCount = 0, colorChanges = 0

  for (let o = HEADER_BYTES; o + RECORD_BYTES <= bytes.length; o += RECORD_BYTES) {
    const { dx, dy, flag } = decodeRecord(bytes[o], bytes[o + 1], bytes[o + 2])
    if (flag === 'end') break
    if (flag === 'stop') {
      colorChanges++
      blocks.push({ stitches: [] })
      continue
    }
    x += dx
    y += dy
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    if (flag === 'jump') jumpCount++
    else stitchCount++
    blocks[blocks.length - 1].stitches.push({ x: x / 10, y: -y / 10, jump: flag === 'jump' || undefined })
  }

  return {
    blocks: blocks.filter((b) => b.stitches.length),
    header: head,
    // back to mm, Y down
    extents: { minX: minX / 10, maxX: maxX / 10, minY: -maxY / 10, maxY: -minY / 10 },
    stitchCount,
    jumpCount,
    colorChanges,
  }
}
