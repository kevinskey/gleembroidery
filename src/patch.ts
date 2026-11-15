// Patch edge — the wrapped border of a cut patch.
//
// This is NOT a satin border with the bars leaned over, which is what the
// faux-overlock setting does and is a different thing: leaning bars imitates
// the LOOK of a serged edge on flat goods. A patch edge has a job — it has
// to encase a raw cut edge so it cannot fray — and that drives three things
// a plain satin border does not do:
//
//   * the bars OVERHANG the outline, so thread wraps past the cut edge
//     rather than stopping on it. A border that stops on the edge leaves
//     the cut fibres proud, which is what frays.
//   * the rails are offsets of the outline, inner and outer, so the band
//     follows the patch rather than being centred on a spine.
//   * corners are a choice. An outside corner is where the outer rail runs
//     much further than the inner one, and what happens there is the
//     difference between a covered corner and a bald one.
//
// Pure and DOM-free.

import type { Pt } from './model'
import type { Stitch } from './stitches'
import { offsetPathsChecked } from './offset'

export type PatchCorner = 'fan' | 'square'

export const PATCH_CORNERS: PatchCorner[] = ['fan', 'square']

export const PATCH_CORNER_LABEL: Record<PatchCorner, string> = {
  fan: 'Fan — extra bars round the outside, corner stays covered',
  square: 'Square — bars stay parallel, corner thins',
}

export interface PatchParams {
  /** Band width across the edge, mm. */
  widthMm: number
  /** Advance per penetration along the rail, mm — same meaning as satin density. */
  density: number
  /** How far the band reaches PAST the cut edge, mm. */
  overhangMm: number
  corner: PatchCorner
}

export const DEFAULT_PATCH = (): PatchParams => ({
  widthMm: 3, density: 0.35, overhangMm: 0.6, corner: 'fan',
})

/** Narrower than this cannot encase a cut edge. */
export const MIN_PATCH_WIDTH_MM = 1.5

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)

function cumulative(pts: Pt[]): number[] {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]))
  return cum
}

function atFraction(pts: Pt[], cum: number[], f: number): Pt {
  const total = cum[cum.length - 1]
  const d = Math.min(Math.max(f, 0), 1) * total
  let i = 1
  while (i < cum.length - 1 && cum[i] < d) i++
  const a = pts[i - 1], b = pts[i]
  const seg = cum[i] - cum[i - 1] || 1
  const t = (d - cum[i - 1]) / seg
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/** Reasons this patch edge will not sew as asked. Empty means it will. */
export function patchCheck(p: PatchParams): string[] {
  const out: string[] = []
  if (p.widthMm < MIN_PATCH_WIDTH_MM) {
    out.push(`a ${p.widthMm.toFixed(1)} mm band cannot encase a cut edge — ${MIN_PATCH_WIDTH_MM} mm is the floor`)
  }
  if (p.overhangMm >= p.widthMm) {
    out.push(`the overhang (${p.overhangMm.toFixed(1)} mm) is the whole band — nothing would sit on the patch itself`)
  }
  if (p.overhangMm <= 0) {
    out.push('no overhang: the band stops on the cut edge and the raw fibres stay proud')
  }
  if (p.density < 0.2) {
    out.push(`${p.density.toFixed(2)} mm spacing is tighter than the needle can take along the rail`)
  }
  return out
}

/**
 * A wrapped border for one CLOSED patch outline.
 *
 * The two rails are offsets: outward by the overhang, inward by the rest of
 * the band. Bars run between them.
 *
 * The corner choice is which rail sets the spacing. On an outside corner the
 * outer rail is the long way round, so spacing it there FANS extra bars into
 * the corner and keeps it covered; spacing the inner rail instead keeps the
 * bars parallel and lets the corner thin out. Neither is wrong — a fan piles
 * thread at a sharp corner, square leaves it bare — so it is a control, not
 * a default to argue about.
 */
export function patchEdge(path: Pt[], p: PatchParams): Stitch[] {
  const ring = path.length > 2 && dist(path[0], path[path.length - 1]) < 1e-6
    ? path.slice(0, -1) : path.slice()
  if (ring.length < 3) return []

  const width = Math.max(MIN_PATCH_WIDTH_MM, p.widthMm)
  const over = Math.min(Math.max(0, p.overhangMm), width - 0.3)
  const inward = width - over

  const outRes = offsetPathsChecked([ring], over)
  const inRes = offsetPathsChecked([ring], -inward)
  const outer = outRes.failed || !outRes.paths[0]?.length ? ring : outRes.paths[0]
  const inner = inRes.failed || !inRes.paths[0]?.length ? ring : inRes.paths[0]
  if (outer.length < 3 || inner.length < 3) return []

  // Close both rings so a bar can land anywhere including across the seam.
  const o = [...outer, outer[0]]
  const n = [...inner, inner[0]]
  const co = cumulative(o), cn = cumulative(n)
  const lenO = co[co.length - 1], lenN = cn[cn.length - 1]
  if (lenO < 1e-6 || lenN < 1e-6) return []

  // Which rail sets the pitch — that IS the corner behaviour.
  const driver = p.corner === 'fan' ? lenO : lenN
  const bars = Math.max(4, Math.round(driver / Math.max(0.2, p.density)))

  const out: Stitch[] = []
  for (let k = 0; k <= bars; k++) {
    const f = k / bars
    // Alternate which rail the needle lands on, which is what a satin bar is.
    if (k % 2 === 0) {
      out.push(atFraction(o, co, f))
      out.push(atFraction(n, cn, f))
    } else {
      out.push(atFraction(n, cn, f))
      out.push(atFraction(o, co, f))
    }
  }
  return out
}

/** Every closed path of a patch object, bordered. */
export function patchStitches(paths: Pt[][], p: PatchParams): Stitch[] {
  const out: Stitch[] = []
  for (const path of paths) out.push(...patchEdge(path, p))
  return out
}
