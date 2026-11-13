// Medial axis of a filled shape, and the variable-width rails around it.
//
// This is what turns a LETTER into SATIN. A glyph is a set of strokes, and a
// satin column runs down the middle of a stroke with its width set by how
// thick the stroke is at that point. Neither the middle nor the thickness is
// recoverable from the outline alone — you have to find the shape's medial
// axis, which is exactly the set of points equidistant from two or more
// boundary points.
//
// Done on the raster the glyph was drawn on, because the alternative — an
// exact Voronoi medial axis of a polygon — is a famously fiddly piece of
// computational geometry whose degenerate cases are precisely the ones
// letterforms are made of (parallel stems, sharp serifs, tangent curves).
// Thinning a bitmap is approximate, but its failure mode is a slightly ragged
// centreline rather than a crash or a spurious branch through a stem.
//
// Pure and DOM-free: it takes a mask, so the suite covers it.

import type { Pt } from './model'

/**
 * Chamfer distance transform: for each set pixel, roughly how far to the
 * nearest clear pixel.
 *
 * 3-4 chamfer weights, two passes. Exact Euclidean distance would be more
 * accurate but this feeds a WIDTH, and the error — under 6% — is far below
 * the precision of the thread it is sizing.
 */
export function distanceTransform(mask: Uint8Array, w: number, h: number): Float32Array {
  const BIG = 1e9
  const d = new Float32Array(w * h)
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? BIG : 0
  const put = (i: number, v: number) => { if (v < d[i]) d[i] = v }
  // forward
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!mask[i]) continue
      if (x > 0) put(i, d[i - 1] + 3)
      if (y > 0) put(i, d[i - w] + 3)
      if (x > 0 && y > 0) put(i, d[i - w - 1] + 4)
      if (x < w - 1 && y > 0) put(i, d[i - w + 1] + 4)
    }
  }
  // backward
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      if (!mask[i]) continue
      if (x < w - 1) put(i, d[i + 1] + 3)
      if (y < h - 1) put(i, d[i + w] + 3)
      if (x < w - 1 && y < h - 1) put(i, d[i + w + 1] + 4)
      if (x > 0 && y < h - 1) put(i, d[i + w - 1] + 4)
    }
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3
  return d
}

/**
 * Zhang-Suen thinning: erode to a one-pixel skeleton, preserving connectivity.
 *
 * Connectivity is the whole point — an erosion that merely shrinks would break
 * a stroke in two wherever it narrows, and each piece would then be satined
 * separately with a gap between them.
 */
export function thin(mask: Uint8Array, w: number, h: number): Uint8Array {
  const m = Uint8Array.from(mask)
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : m[y * w + x])
  let changed = true
  let guard = 0
  while (changed && guard++ < 200) {
    changed = false
    for (const step of [0, 1]) {
      const kill: number[] = []
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x
          if (!m[i]) continue
          const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y)
          const p5 = at(x + 1, y + 1), p6 = at(x, y + 1), p7 = at(x - 1, y + 1)
          const p8 = at(x - 1, y), p9 = at(x - 1, y - 1)
          const n = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
          if (n < 2 || n > 6) continue
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
          let trans = 0
          for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[k + 1] === 1) trans++
          if (trans !== 1) continue
          if (step === 0) {
            if (p2 * p4 * p6 !== 0) continue
            if (p4 * p6 * p8 !== 0) continue
          } else {
            if (p2 * p4 * p8 !== 0) continue
            if (p2 * p6 * p8 !== 0) continue
          }
          kill.push(i)
        }
      }
      if (kill.length) { changed = true; for (const i of kill) m[i] = 0 }
    }
  }
  return m
}

/**
 * Walk a one-pixel skeleton into polylines.
 *
 * Split at junctions: a letter like K is several strokes meeting, and each
 * stroke wants its own satin column. Carrying a branch straight through a
 * junction would sew a column along a path the stroke does not take.
 */
export function traceSkeleton(skel: Uint8Array, w: number, h: number): Pt[][] {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : skel[y * w + x])
  const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]] as const
  const degree = (x: number, y: number) => {
    let n = 0
    for (const [dx, dy] of N8) if (at(x + dx, y + dy)) n++
    return n
  }

  const used = new Set<string>()
  const edge = (a: [number, number], b: [number, number]) =>
    `${Math.min(a[0], b[0])},${Math.min(a[1], b[1])}-${Math.max(a[0], b[0])},${Math.max(a[1], b[1])}`

  const out: Pt[][] = []
  const starts: [number, number][] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!skel[y * w + x]) continue
      const d = degree(x, y)
      // Ends and junctions are where strokes begin and end.
      if (d !== 2) starts.push([x, y])
    }
  }
  // A closed loop (an O) has no endpoint; seed it from any pixel so it is not
  // skipped entirely.
  for (let y = 0; y < h && starts.length === 0; y++) {
    for (let x = 0; x < w; x++) if (skel[y * w + x]) { starts.push([x, y]); break }
  }

  for (const s of starts) {
    for (const [dx, dy] of N8) {
      let cx = s[0], cy = s[1]
      let nx = cx + dx, ny = cy + dy
      if (!at(nx, ny)) continue
      if (used.has(edge([cx, cy], [nx, ny]))) continue
      const line: Pt[] = [{ x: cx, y: cy }]
      let guard = 0
      while (guard++ < 100000) {
        used.add(edge([cx, cy], [nx, ny]))
        line.push({ x: nx, y: ny })
        if (degree(nx, ny) !== 2) break
        let fx = 0, fy = 0, found = false
        for (const [ax, ay] of N8) {
          const px = nx + ax, py = ny + ay
          if (!at(px, py)) continue
          if (used.has(edge([nx, ny], [px, py]))) continue
          fx = px; fy = py; found = true
          break
        }
        if (!found) break
        cx = nx; cy = ny; nx = fx; ny = fy
      }
      if (line.length >= 2) out.push(line)
    }
  }
  return out
}

/**
 * Drop short branches.
 *
 * Thinning sprouts a spur at every bump on the outline — a serif, an
 * antialiased corner — and each one would otherwise become its own tiny satin
 * column stabbing out of the side of a stem.
 */
export function pruneSpurs(lines: Pt[][], minLengthPx: number): Pt[][] {
  return lines.filter((l) => {
    let len = 0
    for (let i = 1; i < l.length; i++) len += Math.hypot(l[i].x - l[i - 1].x, l[i].y - l[i - 1].y)
    return len >= minLengthPx
  })
}

/** Smooth a pixel-stepped centreline so the column does not wobble. */
export function smoothLine(line: Pt[], passes = 3): Pt[] {
  let pts = line.map((p) => ({ ...p }))
  for (let k = 0; k < passes; k++) {
    const next = pts.map((p, i) => {
      if (i === 0 || i === pts.length - 1) return { ...p }
      return {
        x: (pts[i - 1].x + 2 * p.x + pts[i + 1].x) / 4,
        y: (pts[i - 1].y + 2 * p.y + pts[i + 1].y) / 4,
      }
    })
    pts = next
  }
  return pts
}

export interface Rails {
  left: Pt[]
  right: Pt[]
}

/**
 * Build the two rails of a satin column around a centreline.
 *
 * Width comes from the distance transform at each point — doubled, since the
 * transform measures to the nearest edge — so the column is as wide as the
 * stroke actually is and narrows where the stroke narrows. That is the
 * difference between satin lettering and a constant-width stroke pretending
 * to be one.
 */
export function railsAlong(
  line: Pt[], dist: Float32Array, w: number, h: number, scale = 1,
): Rails {
  const left: Pt[] = [], right: Pt[] = []
  const sample = (p: Pt) => {
    const x = Math.max(0, Math.min(w - 1, Math.round(p.x)))
    const y = Math.max(0, Math.min(h - 1, Math.round(p.y)))
    return dist[y * w + x]
  }
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)]
    const b = line[Math.min(line.length - 1, i + 1)]
    let tx = b.x - a.x, ty = b.y - a.y
    const len = Math.hypot(tx, ty)
    if (len < 1e-9) continue
    tx /= len; ty /= len
    const nx = -ty, ny = tx
    const r = Math.max(0.5, sample(line[i]))
    left.push({ x: (line[i].x + nx * r) * scale, y: (line[i].y + ny * r) * scale })
    right.push({ x: (line[i].x - nx * r) * scale, y: (line[i].y - ny * r) * scale })
  }
  return { left, right }
}
