// Document -> stitch plan.
//
// This is the only module that knows the running ORDER of a design, and it
// adds the three things a generator produces but a sewing machine needs:
//
//   * tie-in / tie-off locks, so the first and last stitch of every colour
//     and every trim do not pull out;
//   * a maximum stitch length, because a long normal stitch is a snag and
//     anything past 12.1 mm cannot even be encoded in one DST record;
//   * colour grouping, since each change is a manual re-thread — adjacent
//     objects sharing a colour become ONE block.

import type { Doc, EmbObject, Pt } from './model'
import type { ColorBlock, Stitch, StitchPlan } from './stitches'
import { dist, resample, scanlineSpans, toRegions } from './geometry'
import { unionSelfChecked } from './boolean'
import { edgeUnderlay, tatamiFill, zigzagUnderlay } from './fill'
import { beanStitch, runStitch, satinCheck, satinColumn, satinTwoRail, satinTwoRailUnderlay, satinUnderlay, twoRailCheck } from './satin'

/** Longest normal stitch allowed, mm. DST cannot encode past 12.1 anyway. */
export const MAX_STITCH_MM = 10

/**
 * Shortest sewn stitch, mm.
 *
 * Two penetrations in effectively one hole shred the thread, deflect the
 * needle and perforate knit fabric. Scanline fills generate these constantly
 * where a row clips the tip of a shape, so the floor has to be enforced after
 * generation rather than hoped for.
 */
export const MIN_STITCH_MM = 0.5

/**
 * The floor cannot simply be MIN_STITCH_MM: a tatami row-turn is exactly one
 * row spacing long, so a 0.4 mm fill legitimately contains 0.4 mm stitches,
 * and a satin column's rail step is its density. Suppressing those would weld
 * rows together. So the effective floor is the tightest spacing the DESIGN
 * itself asks for — which still catches the 0.001 mm slivers a scanline emits
 * where a row clips a tip.
 */
function effectiveFloor(doc: Doc): number {
  let floor = MIN_STITCH_MM
  for (const o of doc.objects) {
    if (!o.visible || o.type === 'none') continue
    if (o.type === 'fill') {
      floor = Math.min(floor, o.fill.spacing)
      if (o.fill.border.enabled) floor = Math.min(floor, o.fill.border.density)
    }
    if (o.type === 'satin') floor = Math.min(floor, o.satin.density)
  }
  return Math.max(0.05, floor)
}

/**
 * Travel beyond this is cut and re-started rather than sewn across, mm.
 *
 * This is NOT the same number as the stitch-length cap, though it is easy to
 * conflate them: the cap asks "how long may one stitch be", this asks "how
 * far may thread lie loose on the face of the garment". 6 mm is the committee
 * default; re-set it from the BAI's own trim parameters once those are read
 * off the controller.
 */
export const TRAVEL_TRIM_MM = 6

export interface DigitizeResult {
  plan: StitchPlan
  warnings: string[]
}

/**
 * Lock stitches, as a zigzag rather than a straight back-and-forth.
 *
 * A collinear A-B-A lock at 0.7 mm drops three penetrations into what is
 * effectively two holes, and the machine's own short-stitch filter may eat it
 * — so the thread it was supposed to anchor pulls straight out. Offsetting
 * perpendicular to the direction of travel keeps the holes distinct and gives
 * the lock something to bite on.
 */
function lock(at: Pt, toward: Pt, reverse = false): Stitch[] {
  const d = dist(at, toward) || 1
  const ux = (toward.x - at.x) / d, uy = (toward.y - at.y) / d
  const px = -uy, py = ux // perpendicular
  const step = 1.1
  const off = 0.35
  const a = { x: at.x, y: at.y }
  const b = { x: at.x + ux * step + px * off, y: at.y + uy * step + py * off }
  const c = { x: at.x + ux * step * 2 - px * off, y: at.y + uy * step * 2 - py * off }
  const seq: Stitch[] = [a, b, c, b].map((q) => ({ ...q, lock: true }))
  return reverse ? seq.reverse() : seq
}

/** Subdivide any normal stitch longer than max into equal sewable steps. */
function enforceMaxStitch(stitches: Stitch[], max = MAX_STITCH_MM): Stitch[] {
  const out: Stitch[] = []
  for (const s of stitches) {
    const prev = out[out.length - 1]
    if (prev && !s.jump) {
      const d = dist(prev, s)
      if (d > max) {
        const n = Math.ceil(d / max)
        for (let i = 1; i < n; i++)
          out.push({ x: prev.x + (s.x - prev.x) * (i / n), y: prev.y + (s.y - prev.y) * (i / n) })
      }
    }
    out.push(s)
  }
  return out
}

/**
 * Remove penetrations closer together than the floor.
 *
 * The short stitch is ABSORBED, not dropped: the survivor keeps the later
 * point, so a fill row still reaches the outline it was clipped against and
 * the shape does not shrink. Jumps and trims are structural and pass through
 * untouched, as does the final point of a run.
 */
function suppressShortStitches(stitches: Stitch[], min = MIN_STITCH_MM): Stitch[] {
  const out: Stitch[] = []
  for (const s of stitches) {
    const prev = out[out.length - 1]
    if (prev && !s.jump && !s.trim) {
      const d = dist(prev, s)
      // A sewn point a hair from where a jump just landed is never worth a
      // penetration — at d=0 it is an outright duplicate, and at 0.2 mm it is
      // a needle-up move followed by a stitch into the same hole. Either way
      // the fix is to land the JUMP on the useful point instead.
      //
      // A LOCK is exempt: its whole job is to put short stitches next to each
      // other, and absorbing it is what left every trim restarting untied.
      if (prev.jump && d < min && !s.lock) {
        out[out.length - 1] = { ...prev, x: s.x, y: s.y }
        continue
      }
      if (!prev.jump && !prev.trim && d < min && !s.lock && !prev.lock) {
        // Keep the newer position so the row still lands on the boundary.
        out[out.length - 1] = { ...prev, x: s.x, y: s.y }
        continue
      }
    }
    out.push(s)
  }
  return out
}

/**
 * Narrowest span across a region, mm — a cheap proxy for local limb width.
 * Sampled on a handful of scanlines rather than a medial axis; it only has to
 * be good enough to stop an underlay inset from crossing a thin shape.
 */
function shortestSpan(region: Pt[][]): number {
  let minY = Infinity, maxY = -Infinity
  for (const ring of region) for (const p of ring) {
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  if (!isFinite(minY) || maxY - minY < 1e-9) return 1
  let narrowest = Infinity
  for (let i = 1; i <= 16; i++) {
    const y = minY + ((maxY - minY) * i) / 17
    for (const [a, b] of scanlineSpans(region, y)) narrowest = Math.min(narrowest, b - a)
  }
  return isFinite(narrowest) ? narrowest : 1
}

/** Jumps shorter than this are a needle-up cycle for nothing — just sew them. */
const POINTLESS_JUMP_MM = 1.0

/**
 * Turn bare travel into machine-correct travel.
 *
 * Generators emit plain jumps wherever they cannot sew from A to B. A real
 * machine needs more than that: a jump run triggers the auto-trim on a
 * Dahao-controlled BAI, so a jump with no tie-off either side gets CUT at a
 * point where nothing anchors the thread — loose ends on the face and a
 * bird's nest under the throat plate. So every travel long enough to be cut
 * is wrapped: tie off, trim, travel, tie back in.
 */
function applyTrimsAndLocks(stitches: Stitch[], travel = TRAVEL_TRIM_MM): Stitch[] {
  const out: Stitch[] = []
  for (let i = 0; i < stitches.length; i++) {
    const s = stitches[i]
    const prev = out[out.length - 1]
    if (s.jump && prev) {
      const gap = dist(prev, s)
      if (gap <= POINTLESS_JUMP_MM) {
        out.push({ x: s.x, y: s.y }) // shorter than a stitch; it hides
        continue
      }
      if (gap > travel) {
        out.push(...lock(prev, out[out.length - 2] ?? s, true))
        out.push({ x: s.x, y: s.y, jump: true, trim: true })
        // The tie-in must aim at a point that is genuinely DIFFERENT from the
        // landing point. The jump was synthesised from the next stitch, so
        // `stitches[i+1]` is usually the same coordinate — lock() then divides
        // a zero vector, every lock point collapses onto `s`, and
        // suppressShortStitches deletes the lot. The result was a machine that
        // cuts, travels, and sews into bare fabric with nothing anchoring the
        // new thread end. Scan forward for the first point that actually moves.
        const aim = nextDistinct(stitches, i + 1, s)
        if (aim) out.push(...lock(s, aim).slice(1))
        continue
      }
    }
    out.push(s)
  }
  return out
}

/** First point at or after `from` that is a real distance from `at`. */
function nextDistinct(stitches: Stitch[], from: number, at: Pt): Pt | null {
  for (let i = from; i < stitches.length; i++) {
    const s = stitches[i]
    if (dist(at, s) > 1e-6) return { x: s.x, y: s.y }
  }
  return null
}

function stitchObject(obj: EmbObject, warnings: string[], floor = MIN_STITCH_MM): Stitch[] {
  const out: Stitch[] = []
  const push = (parts: Stitch[]) => {
    if (!parts.length) return
    if (out.length) {
      const gap = dist(out[out.length - 1], parts[0])
      // Anything past the travel threshold lifts the needle; applyTrimsAndLocks
      // then decides whether it also gets cut.
      if (gap > TRAVEL_TRIM_MM) out.push({ ...parts[0], jump: true })
    }
    out.push(...parts)
  }

  switch (obj.type) {
    case 'none':
      return []

    case 'run':
      for (const path of obj.paths) push(runStitch(path, obj.run))
      break

    case 'bean':
      for (const path of obj.paths) push(beanStitch(path, obj.run))
      break

    case 'satin':
      // TWO paths is a two-rail column: the digitizer drew both edges, so the
      // width is the gap between them rather than a single number. One path
      // keeps the spine+width behaviour. Anything else is several independent
      // columns, which is what the loop below already does.
      if (obj.paths.length === 2 && obj.twoRail) {
        const [ra, rb] = obj.paths
        const check = twoRailCheck(ra, rb, obj.satin)
        for (const w of check.warnings) warnings.push(`${obj.name}: ${w}`)
        if (check.errors.length) {
          for (const e of check.errors) warnings.push(`${obj.name}: NOT STITCHED — ${e}`)
          break
        }
        push(satinTwoRailUnderlay(ra, rb, obj.satin))
        push(satinTwoRail(ra, rb, obj.satin))
        break
      }
      for (const path of obj.paths) {
        const check = satinCheck(path, obj.satin)
        for (const w of check.warnings) warnings.push(`${obj.name}: ${w}`)
        if (check.errors.length) {
          // Refuse rather than emit a column that cannot be sewn. The object
          // contributes nothing and the operator is told exactly why.
          for (const e of check.errors) warnings.push(`${obj.name}: NOT STITCHED — ${e}`)
          continue
        }
        push(satinUnderlay(path, obj.satin))
        push(satinColumn(path, obj.satin))
      }
      break

    case 'fill': {
      // Geometry preparation (spec §5): resolve the object against ITSELF
      // first. Overlapping subpaths otherwise sew at double density or leave
      // the overlap bald, depending only on vertex order.
      const merged = unionSelfChecked(obj.paths)
      if (merged.failed)
        warnings.push(`${obj.name}: overlapping outlines could not be merged — any overlap may sew at double density`)
      const regions = toRegions(merged.paths)
      if (!regions.length) {
        warnings.push(`${obj.name}: no closed area to fill — set it to Run or Satin`)
        break
      }
      const report: (m: string) => void = (m) => warnings.push(`${obj.name}: ${m}`)
      for (const region of regions) {
        const p = obj.fill
        if (p.underlay === 'edge' || p.underlay === 'double') {
          // The inset must not exceed a quarter of the local width, or on a
          // thin limb the underlay lands on or past the opposite edge.
          const inset = Math.min(1.0, Math.max(0.2, shortestSpan(region) * 0.25))
          push(edgeUnderlay(region, inset, 2.5, report))
        }
        if (p.underlay === 'zigzag' || p.underlay === 'double') push(zigzagUnderlay(region, p.angle, report))
        push(tatamiFill(region, p, out.length ? out[out.length - 1] : undefined, report))
        if (p.border.enabled) {
          for (const ring of region) {
            const borderPath = [...ring, ring[0]]
            const borderParams = {
              width: p.border.width,
              density: p.border.density,
              pullComp: 0,
              underlay: 'none' as const,
            }
            // The border is satin and must pass the SAME check the satin tool
            // does. It used to bypass it entirely, so the engine refused a
            // column when the user drew one and silently emitted the identical
            // unsewable geometry when a fill generated it.
            const bc = satinCheck(borderPath, borderParams)
            for (const w of bc.warnings) warnings.push(`${obj.name} border: ${w}`)
            if (bc.errors.length) {
              for (const e of bc.errors) warnings.push(`${obj.name} border: NOT STITCHED — ${e}`)
              continue
            }
            push(
              satinColumn(borderPath, borderParams),
            )
          }
        }
      }
      break
    }
  }

  if (out.length < 2) return out
  // Locks top and tail, then machine-correct travel, then the two length
  // limits. Order matters: the locks must exist before the length passes run,
  // or enforceMaxStitch subdivides a travel the lock was meant to bracket.
  const head = lock(out[0], out[1])
  const tail = lock(out[out.length - 1], out[out.length - 2], true)
  return suppressShortStitches(enforceMaxStitch(applyTrimsAndLocks([...head, ...out, ...tail])), floor)
}

/**
 * What decides whether two objects share a needle: the assigned thread if
 * there is one, otherwise the screen colour.
 */
function threadKey(objects: EmbObject[], label: string, color: string): string {
  const first = label.split(' + ')[0]
  const t = objects.find((o) => o.name === first)?.thread
  const assigned = [t?.brand, t?.code].filter(Boolean).join(' ').trim()
  return assigned ? `t:${assigned.toLowerCase()}` : `c:${color.toLowerCase()}`
}

export function digitize(doc: Doc): DigitizeResult {
  const warnings: string[] = []
  const blocks: ColorBlock[] = []
  const floor = effectiveFloor(doc)

  for (const obj of doc.objects) {
    if (!obj.visible || obj.type === 'none') continue
    const stitches = stitchObject(obj, warnings, floor)
    if (!stitches.length) continue

    // Merge only when the NEEDLE would not change. Keying on the screen
    // colour alone merged two objects carrying different thread codes into
    // one block, and the run sheet then printed only the first spool.
    const last = blocks[blocks.length - 1]
    const lastKey = blocks.length ? threadKey(doc.objects, last.label, last.color) : null
    if (last && lastKey === threadKey(doc.objects, obj.name, obj.color)) {
      // Same thread already in the needle — travel, do not stop the machine.
      // slice(1) because the jump already lands on stitches[0]; repeating it
      // as a sewn point is a zero-length stitch.
      last.stitches.push({ ...stitches[0], jump: true, trim: true }, ...stitches.slice(1))
      last.label += ` + ${obj.name}`
    } else {
      // The first penetration of a block is reached needle-UP: after a colour
      // change the needle is wherever the last block ended, which is nowhere
      // near where this one starts.
      blocks.push({
        color: obj.color,
        label: obj.name,
        stitches: [{ ...stitches[0], jump: true }, ...stitches.slice(1)],
      })
    }
  }

  const plan: StitchPlan = { blocks }

  // Hoop check — the one error that wastes a garment rather than a test scrap.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const b of blocks) for (const s of b.stitches) {
    if (s.x < minX) minX = s.x
    if (s.y < minY) minY = s.y
    if (s.x > maxX) maxX = s.x
    if (s.y > maxY) maxY = s.y
  }
  if (isFinite(minX)) {
    const w = maxX - minX, h = maxY - minY
    const hw = doc.hoop.widthMm, hh = doc.hoop.heightMm
    if (w > hw || h > hh) {
      // Turning the design is free and often all it takes, so say so rather
      // than just reporting failure.
      const fitsRotated = h <= hw && w <= hh
      warnings.push(
        `Design is ${w.toFixed(1)} × ${h.toFixed(1)} mm — the ${doc.hoop.name} sewing field is ` +
          `${hw.toFixed(0)} × ${hh.toFixed(0)} mm` +
          (fitsRotated ? '. It fits rotated 90°.' : '.'),
      )
    }
  }

  // A hoop the machine cannot physically mount is a different failure from a
  // design that is too big, and the operator finds out at the machine.
  if (doc.hoop.minSpacing) {
    const rank: Record<string, number> = { TJ360: 0, CH400A: 1, TJ500: 2, TJ600: 3 }
    if (rank[doc.hoop.minSpacing] > rank[doc.spacing])
      warnings.push(
        `${doc.hoop.name} needs ${doc.hoop.minSpacing} bracket spacing; this machine is set to ${doc.spacing}`,
      )
  }

  return { plan, warnings }
}

/**
 * Centre the plan on the origin. DST is read by the machine as relative to
 * where the needle starts, and every commercial file in the wild is centred,
 * so the operator's hoop-centre lines up with the design centre.
 */
export function centerPlan(plan: StitchPlan): StitchPlan {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const b of plan.blocks) for (const s of b.stitches) {
    if (s.x < minX) minX = s.x
    if (s.y < minY) minY = s.y
    if (s.x > maxX) maxX = s.x
    if (s.y > maxY) maxY = s.y
  }
  if (!isFinite(minX)) return plan
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  return {
    blocks: plan.blocks.map((b) => ({
      ...b,
      stitches: b.stitches.map((s) => ({ ...s, x: s.x - cx, y: s.y - cy })),
    })),
  }
}

/** Re-sample an imported stitch file back into editable run paths. */
export function stitchesToPaths(stitches: Stitch[], length = 2.5): Pt[][] {
  const paths: Pt[][] = []
  let cur: Pt[] = []
  for (const s of stitches) {
    if (s.jump) {
      if (cur.length > 1) paths.push(resample(cur, length))
      cur = []
      continue
    }
    cur.push({ x: s.x, y: s.y })
  }
  if (cur.length > 1) paths.push(resample(cur, length))
  return paths
}
