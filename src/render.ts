// Canvas rendering: hoop, rulers, artwork outlines and the stitch plan.
//
// World units are mm with the ORIGIN AT THE HOOP CENTRE and +Y down, which
// matches both the document and the way a machine is set up — the operator
// centres the hoop and the design grows out from there.

import type { Doc, Pt } from './model'
import { handlesOf, type Shape } from './nodes'
import { densityColour } from './density'
import type { StitchPlan } from './stitches'

export interface View {
  scale: number // screen px per mm
  cx: number // world mm at canvas centre
  cy: number
}

export const MM_PER_IN = 25.4

export function worldToScreen(v: View, w: number, h: number, p: Pt): Pt {
  return { x: w / 2 + (p.x - v.cx) * v.scale, y: h / 2 + (p.y - v.cy) * v.scale }
}

export function screenToWorld(v: View, w: number, h: number, p: Pt): Pt {
  return { x: (p.x - w / 2) / v.scale + v.cx, y: (p.y - h / 2) / v.scale + v.cy }
}

export function fitView(doc: Doc, w: number, h: number): View {
  const pad = 48
  const scale = Math.min((w - pad) / doc.hoop.widthMm, (h - pad) / doc.hoop.heightMm)
  return { scale: Math.max(0.2, scale), cx: 0, cy: 0 }
}

export interface RenderOptions {
  showGrid: boolean
  showArt: boolean
  showStitches: boolean
  showPoints: boolean
  showJumps: boolean
  /** Draw only the first N stitches — the stitch-out simulation. */
  upTo?: number
  selectedId?: string | null
  /** Read-only plan loaded from a file, drawn behind the document. */
  reference?: StitchPlan | null
  /** Shape being dragged out right now, drawn live and owned by nobody yet. */
  draft?: { paths: Pt[][]; closed: boolean } | null
  /**
   * The pen's own nodes, and the marker showing what the next click places.
   *
   * Separate from `draft` because a draft is a SHAPE — a rectangle being
   * dragged out, a freehand trail — and has no node types to show. A pen path
   * does: every point is either a corner or a curve, and which one is about
   * to be placed is the single thing the digitizer needs to know before
   * clicking.
   */
  pen?: {
    nodes: readonly { x: number; y: number; smooth?: boolean }[]
    /** Where the next node would land, and what kind it would be. */
    next?: { at: Pt; smooth: boolean } | null
  } | null
  /** Selection bounds to draw resize handles on. */
  selectionBox?: { minX: number; minY: number; maxX: number; maxY: number } | null
  /** Editable outlines to draw nodes and Bézier handles for. */
  nodeEdit?: { shapes: readonly Shape[]; active?: { s: number; i: number } | null } | null
  /** Px above the selection to put the rotation grip; omit to hide it. */
  rotateOffsetPx?: number
  /** Rubber band being dragged over empty space. */
  marquee?: { a: Pt; b: Pt } | null
  /** A grip at the centre of each letter, for nudging letters singly. */
  letterHandles?: Pt[] | null
  /** Where the selected object starts and finishes sewing. */
  endpoints?: { entry?: Pt; exit?: Pt } | null
  /**
   * Satin angle guides: the ones already placed, and the one being drawn.
   *
   * Drawn like the other overlays — AFTER the stitches. A guide lies across
   * the densest part of a column, which is exactly where thread painted over
   * it last time.
   */
  guides?: { lines: { a: Pt; b: Pt }[]; draft?: { a: Pt; b: Pt } | null } | null
  /** Stitches picked for direct editing. */
  picked?: { block: number; index: number }[] | null
  /** Over-dense cells to shade, with the grid size they were counted on. */
  density?: { cells: { x: number; y: number; ratio: number }[]; cellMm: number } | null
  /**
   * The garment colour, '#rrggbb'. Absent means the plain work area.
   *
   * A design that reads on white can disappear on navy, and that is not
   * something a preview on a neutral background can tell you.
   */
  fabric?: string
  /** Reference image drawn behind everything, for tracing over. */
  backdrop?: { bitmap: CanvasImageSource; origin: Pt; widthMm: number; heightMm: number } | null
}

const RULER = 22 // px gutter for the rulers

/**
 * Thread rendering.
 *
 * A colour block drawn as ONE polyline with round caps is a ribbon, not
 * thread: at any real zoom it reads as melted wax, with a bump wherever the
 * line happens to turn. Real thread is lots of SEPARATE strands, each a
 * little round cord catching the light from one direction.
 *
 * So above a zoom where it can actually be seen, each stitch is drawn as its
 * own segment in three passes — a dark side, the body, and a highlight,
 * offset fractions of a thread width ACROSS the stitch. That gives every
 * stitch a lit edge and a shaded edge, which is what makes it read as round
 * and as lifted off the fabric.
 *
 * Three passes per BLOCK, not per stitch: each pass accumulates every
 * segment into one path and strokes once. The cost is three strokes per
 * colour, not three per stitch, which is what keeps it usable while dragging.
 */
const THREAD_MM = 0.4

/**
 * The per-letter nudge handles, in screen px.
 *
 * Shared with the hit test in App.tsx so the target is exactly what is drawn
 * — a marker smaller than its hit area feels unreliable, and larger feels
 * broken.
 */
export const LETTER_HANDLE_PX = 13
/** Below this zoom a thread is a couple of pixels; the detail is invisible. */
const DETAIL_SCALE = 5
/** Past this many stitches, stay on the fast path whatever the zoom. */
const DETAIL_MAX_STITCHES = 80_000
/**
 * A stitch is a ROUND CORD, drawn as stacked translucent strokes.
 *
 * The previous version shaded each stitch along its length — dark at the
 * ends where it enters the cloth, bright in the middle — on the theory that
 * a satin bar really does sit proud in the middle. It does, but drawing it
 * that way made every stitch a high-contrast chunk with dark ends, and a
 * tatami fill of 4 mm stitches came out as a heap of bricks rather than a
 * surface. A digitizer could not read it, which is the only test that counts.
 *
 * What reads correctly is the way the realistic renderers do it: lay down a
 * soft wide shadow, the cord over it, then a narrow bright crown ALONG the
 * whole length. Three strokes of decreasing width approximate a cylinder lit
 * from above, the shadow spreads under the neighbouring strands and merges
 * the rows into one surface, and the crown gives the sheen that makes thread
 * look like thread. No banding, no bricks.
 *
 * Widths are fractions of the laid thread width; alphas are what keeps the
 * overlaps from turning into mud.
 */
const SHADOW_W = 1.18, SHADOW_A = 0.20, SHADOW_T = -0.38
const CORD_W = 1.06, CORD_A = 1.0
const CROWN_W = 0.52, CROWN_A = 0.26, CROWN_T = 0.26

/**
 * How much of each stitch the cord and the crown cover, end to end.
 *
 * The ends are left to the shadow pass, which is what darkens a stitch where
 * it dips into the fabric. Without this the three passes are concentric down
 * the whole length and the only variation is ACROSS the stitch — which is the
 * mistake v1 made, and it reads as stripes rather than thread.
 */
const BODY_SPAN = 0.9, CROWN_SPAN = 0.52

/**
 * How far a stitch end may wander, as a fraction of a thread width.
 *
 * Real stitch ends do not land on a ruled line — the needle pulls the cloth
 * and each penetration sits a hair off its neighbours, which is why the edge
 * of a real satin column is finely serrated rather than knife-straight. The
 * wobble is HASHED from the stitch's own coordinates, not random: the same
 * design must draw identically every frame, or the whole fill shimmers while
 * panning.
 */
// Serration on a column edge is FINE in real embroidery — a few hundredths
// of a millimetre, not a scallop. At 0.22 of a thread width every outline
// came out chewed next to a reference rendering, which is the comparison
// that settled it.
const EDGE_WOBBLE = 0.07

function wobble(x: number, y: number): number {
  // Cheap deterministic hash; the exact mixing does not matter, only that it
  // is stable and decorrelated between neighbouring stitches.
  let h = Math.imul(Math.round(x * 16) ^ 0x9e3779b9, 0x85ebca6b)
  h ^= Math.imul(Math.round(y * 16) ^ 0xc2b2ae35, 0x27d4eb2f)
  h ^= h >>> 15
  return ((h >>> 0) / 0xffffffff) * 2 - 1
}

/** Mix a hex colour towards white (t > 0) or black (t < 0). */
/** Perceived brightness, 0..1 — what decides whether to lighten or darken. */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return 1
  const n = parseInt(m[1], 16)
  // Rec. 601 weights: green carries most of the perceived brightness, so a
  // plain average calls mid-green dark and mid-blue light.
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
}

function shade(hex: string, t: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const mix = (c: number) => Math.max(0, Math.min(255, Math.round(t >= 0 ? c + (255 - c) * t : c * (1 + t))))
  return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`
}

export function render(
  ctx: CanvasRenderingContext2D,
  doc: Doc,
  plan: StitchPlan,
  view: View,
  opt: RenderOptions,
) {
  const { width: w, height: h } = ctx.canvas
  const dpr = window.devicePixelRatio || 1
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const W = w / dpr, H = h / dpr

  const dark = matchMedia('(prefers-color-scheme: dark)').matches
  const paper = dark ? '#171a1f' : '#fbf8ea' // StitchArtist's cream work area
  const ink = dark ? '#cfd6e0' : '#3a3630'

  // THE FABRIC. What is inside the hoop is cloth, and the colour of that
  // cloth changes the design: a white logo is invisible on white and a navy
  // one disappears on navy, and neither is apparent against an application
  // background that is neither. Everything drawn ON the cloth takes its
  // contrast from the cloth rather than from the window's theme, or a grid
  // that was readable on cream vanishes on black.
  const cloth = opt.fabric || paper
  const clothDark = luminance(cloth) < 0.45
  const onCloth = (t: number) => shade(cloth, clothDark ? t : -t)

  ctx.fillStyle = dark ? '#0f1216' : '#e8e4d6'
  ctx.fillRect(0, 0, W, H)

  const toS = (p: Pt) => worldToScreen(view, W, H, p)

  // --- hoop ---------------------------------------------------------------
  const hw = doc.hoop.widthMm / 2, hh = doc.hoop.heightMm / 2
  const tl = toS({ x: -hw, y: -hh }), br = toS({ x: hw, y: hh })
  ctx.fillStyle = cloth
  ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y)

  // --- grid ---------------------------------------------------------------
  if (opt.showGrid) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y)
    ctx.clip()
    ctx.strokeStyle = onCloth(0.13)
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    // One line per inch — the ruler is in inches, so the grid should agree.
    for (let i = -Math.ceil(hw / MM_PER_IN); i <= Math.ceil(hw / MM_PER_IN); i++) {
      const x = Math.round(toS({ x: i * MM_PER_IN, y: 0 }).x) + 0.5
      ctx.beginPath(); ctx.moveTo(x, tl.y); ctx.lineTo(x, br.y); ctx.stroke()
    }
    for (let i = -Math.ceil(hh / MM_PER_IN); i <= Math.ceil(hh / MM_PER_IN); i++) {
      const y = Math.round(toS({ x: 0, y: i * MM_PER_IN }).y) + 0.5
      ctx.beginPath(); ctx.moveTo(tl.x, y); ctx.lineTo(br.x, y); ctx.stroke()
    }
    ctx.restore()
  }

  // Centre cross — the needle's start point.
  ctx.strokeStyle = onCloth(0.28)
  ctx.lineWidth = 1
  ctx.setLineDash([6, 4])
  const o = toS({ x: 0, y: 0 })
  ctx.beginPath(); ctx.moveTo(tl.x, Math.round(o.y) + 0.5); ctx.lineTo(br.x, Math.round(o.y) + 0.5); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(Math.round(o.x) + 0.5, tl.y); ctx.lineTo(Math.round(o.x) + 0.5, br.y); ctx.stroke()
  ctx.setLineDash([])

  // Hoop edge.
  ctx.strokeStyle = onCloth(0.45)
  ctx.lineWidth = 2
  ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y)

  // --- reference design loaded from a file --------------------------------
  if (opt.reference) {
    ctx.lineWidth = 1
    ctx.strokeStyle = onCloth(0.3)
    for (const b of opt.reference.blocks) {
      ctx.beginPath()
      let pen = false
      for (const s of b.stitches) {
        const p = toS(s)
        if (s.jump) { pen = false; continue }
        if (!pen) { ctx.moveTo(p.x, p.y); pen = true } else ctx.lineTo(p.x, p.y)
      }
      ctx.stroke()
    }
  }

  // --- artwork outlines ---------------------------------------------------
  // --- reference image ------------------------------------------------------
  // Behind everything and faded: it is something to trace OVER, and at full
  // strength it competes with the stitches that matter.
  if (opt.backdrop) {
    const a = toS(opt.backdrop.origin)
    const b = toS({
      x: opt.backdrop.origin.x + opt.backdrop.widthMm,
      y: opt.backdrop.origin.y + opt.backdrop.heightMm,
    })
    ctx.save()
    ctx.globalAlpha = 0.45
    try { ctx.drawImage(opt.backdrop.bitmap, a.x, a.y, b.x - a.x, b.y - a.y) } catch { /* not ready */ }
    ctx.restore()
  }

  if (opt.showArt) {
    for (const obj of doc.objects) {
      if (!obj.visible || !obj.paths.length) continue
      const sel = obj.id === opt.selectedId
      ctx.strokeStyle = sel ? '#1f9cf0' : dark ? '#55606e' : '#a89f86'
      ctx.lineWidth = sel ? 2 : 1
      ctx.setLineDash(sel ? [] : [4, 3])
      for (const path of obj.paths) {
        if (path.length < 2) continue
        ctx.beginPath()
        const p0 = toS(path[0])
        ctx.moveTo(p0.x, p0.y)
        for (let i = 1; i < path.length; i++) { const p = toS(path[i]); ctx.lineTo(p.x, p.y) }
        ctx.stroke()
      }
      ctx.setLineDash([])
    }
  }

  // --- node editing ---------------------------------------------------------
  // Handle arms are drawn BEFORE the nodes so a node always sits on top of its
  // own arms; the node is the thing being aimed at.
  if (opt.nodeEdit) {
    const { shapes, active } = opt.nodeEdit
    ctx.save()
    shapes.forEach((sh, si) => {
      ctx.strokeStyle = '#1f9cf0'
      ctx.lineWidth = 1
      for (const h of handlesOf(sh)) {
        const n = sh.nodes[h.i]
        const a = toS({ x: n.x, y: n.y })
        const b = toS(h.at)
        ctx.globalAlpha = 0.6
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
        ctx.globalAlpha = 1
        ctx.beginPath(); ctx.arc(b.x, b.y, 3, 0, Math.PI * 2)
        ctx.fillStyle = dark ? '#0f1216' : '#ffffff'
        ctx.fill(); ctx.stroke()
      }
      sh.nodes.forEach((n, i) => {
        const q = toS({ x: n.x, y: n.y })
        const on = active && active.s === si && active.i === i
        ctx.fillStyle = on ? '#1f9cf0' : dark ? '#0f1216' : '#ffffff'
        ctx.strokeStyle = '#1f9cf0'
        ctx.lineWidth = on ? 2 : 1
        // Round = smooth, square = corner. The shape of the marker IS the
        // node's type, so it needs no legend and survives being colour-blind.
        ctx.beginPath()
        if (n.smooth) ctx.arc(q.x, q.y, 4, 0, Math.PI * 2)
        else ctx.rect(q.x - 3.5, q.y - 3.5, 7, 7)
        ctx.fill(); ctx.stroke()
      })
    })
    ctx.restore()
  }

  // --- selection handles --------------------------------------------------
  // Drawn in SCREEN space at a fixed pixel size: a handle sized in mm would be
  // invisible zoomed out and cover the shape zoomed in.
  if (opt.selectionBox) {
    const b = opt.selectionBox
    const a = toS({ x: b.minX, y: b.minY })
    const c = toS({ x: b.maxX, y: b.maxY })
    ctx.save()
    ctx.strokeStyle = '#1f9cf0'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    ctx.strokeRect(a.x, a.y, c.x - a.x, c.y - a.y)
    ctx.setLineDash([])
    const mx = (a.x + c.x) / 2, my = (a.y + c.y) / 2
    const R = 3.5
    // Rotation grip on a stalk above the box, clear of the resize handles so
    // the two are never ambiguous however far the view is zoomed out.
    if (opt.rotateOffsetPx) {
      const gy = a.y - opt.rotateOffsetPx
      ctx.beginPath(); ctx.moveTo(mx, a.y); ctx.lineTo(mx, gy); ctx.stroke()
      ctx.beginPath(); ctx.arc(mx, gy, 4.5, 0, Math.PI * 2)
      ctx.fillStyle = dark ? '#0f1216' : '#ffffff'
      ctx.fill(); ctx.stroke()
      // A tick inside the grip so it reads as "turn", not as another handle.
      ctx.beginPath(); ctx.arc(mx, gy, 2, -0.6, Math.PI * 1.1); ctx.stroke()
    }
    ctx.fillStyle = dark ? '#0f1216' : '#ffffff'
    for (const [hx, hy] of [
      [a.x, a.y], [mx, a.y], [c.x, a.y],
      [a.x, my], [c.x, my],
      [a.x, c.y], [mx, c.y], [c.x, c.y],
    ]) {
      ctx.beginPath()
      ctx.rect(hx - R, hy - R, R * 2, R * 2)
      ctx.fill()
      ctx.stroke()
    }
    ctx.restore()
  }

  // --- marquee --------------------------------------------------------------
  if (opt.marquee) {
    const a = toS(opt.marquee.a)
    const b = toS(opt.marquee.b)
    ctx.save()
    ctx.strokeStyle = '#1f9cf0'
    ctx.fillStyle = 'rgba(31,156,240,0.12)'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y)
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y)
    ctx.restore()
  }

  // --- the shape being drawn ----------------------------------------------
  // Always drawn, even with ART off: hiding the thing under the cursor would
  // make the tool feel broken. Accent-coloured so it reads as not-yet-real.
  if (opt.draft) {
    ctx.save()
    ctx.strokeStyle = '#1f9cf0'
    ctx.lineWidth = 1.5
    ctx.setLineDash([5, 3])
    for (const path of opt.draft.paths) {
      if (path.length < 2) continue
      ctx.beginPath()
      const p0 = toS(path[0])
      ctx.moveTo(p0.x, p0.y)
      for (let i = 1; i < path.length; i++) { const p = toS(path[i]); ctx.lineTo(p.x, p.y) }
      if (opt.draft.closed) ctx.closePath()
      ctx.stroke()
      // Mark the committed vertices so a polygon shows what it has so far.
      // The pen draws its own, by type, below.
      if (!opt.pen) {
        ctx.setLineDash([])
        ctx.fillStyle = '#1f9cf0'
        for (const q of path) { const p = toS(q); ctx.fillRect(p.x - 2, p.y - 2, 4, 4) }
        ctx.setLineDash([5, 3])
      }
    }
    ctx.restore()
  }

  // --- the pen's nodes, and the marker at the cursor ----------------------
  //
  // The marker IS the answer to "what will this click do". A square places a
  // corner, a circle places a curve, and holding the modifier changes it
  // under the cursor before anything is committed — so the choice is made by
  // looking rather than by remembering which key does what.
  if (opt.pen) {
    ctx.save()
    const mark = (p: Pt, smooth: boolean, filled: boolean) => {
      ctx.beginPath()
      if (smooth) ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
      else ctx.rect(p.x - 3.5, p.y - 3.5, 7, 7)
      ctx.fillStyle = filled ? '#1f9cf0' : dark ? '#0f1216' : '#ffffff'
      ctx.strokeStyle = '#1f9cf0'
      ctx.lineWidth = filled ? 1 : 1.5
      ctx.fill()
      ctx.stroke()
    }
    // Placed nodes are solid: they are decided. Same square/round language
    // the Nodes tool uses, so the two tools read the same way.
    for (const n of opt.pen.nodes) mark(toS({ x: n.x, y: n.y }), !!n.smooth, true)
    // The one under the cursor is hollow, because it has not been placed yet.
    if (opt.pen.next) mark(toS(opt.pen.next.at), opt.pen.next.smooth, false)
    ctx.restore()
  }

  // --- stitches -----------------------------------------------------------
  if (opt.showStitches) {
    let drawn = 0
    const limit = opt.upTo ?? Infinity
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const threadPx = Math.max(0.8, THREAD_MM * view.scale)
    const total = plan.blocks.reduce((n, b) => n + b.stitches.length, 0)
    // Detail only where it can be seen and afforded; otherwise the old fast
    // polyline, which at that size looks the same anyway.
    const detailed = view.scale >= DETAIL_SCALE && total <= DETAIL_MAX_STITCHES

    for (const b of plan.blocks) {
      if (drawn >= limit) break
      if (!detailed) {
        ctx.strokeStyle = b.color
        ctx.lineWidth = threadPx
        ctx.beginPath()
        let pen = false
        for (const st of b.stitches) {
          if (drawn >= limit) break
          drawn++
          const p = toS(st)
          if (st.jump) { pen = false; continue }
          if (!pen) { ctx.moveTo(p.x, p.y); pen = true } else ctx.lineTo(p.x, p.y)
        }
        ctx.stroke()
        continue
      }

      // Collect this block's sewn segments once, then stroke three offset
      // passes over them.
      const segs: [number, number, number, number][] = []
      let prev: Pt | null = null
      for (const st of b.stitches) {
        if (drawn >= limit) break
        drawn++
        const p = toS(st)
        if (st.jump) { prev = null; continue }
        if (prev) {
          // Nudge each end ALONG the stitch so the column's edge serrates
          // instead of ruling straight.
          let dx = p.x - prev.x, dy = p.y - prev.y
          const len = Math.hypot(dx, dy)
          if (len > 1e-6) {
            dx /= len; dy /= len
            const a = wobble(prev.x, prev.y) * threadPx * EDGE_WOBBLE
            const c = wobble(p.x, p.y) * threadPx * EDGE_WOBBLE
            segs.push([prev.x - dx * a, prev.y - dy * a, p.x + dx * c, p.y + dy * c])
          } else segs.push([prev.x, prev.y, p.x, p.y])
        }
        prev = p
      }
      if (!segs.length) continue

      /**
       * Stroke every segment at once, keeping only the middle `span` of each.
       *
       * Three spans stacked — full, middle, centre — give each strand dark
       * ends and a bright crown without a gradient per stitch, which at these
       * counts would be thousands of gradient objects per frame.
       */
      /**
       * How wide to actually draw the thread.
       *
       * A thread's nominal 0.4 mm is its diameter relaxed; laid under tension
       * it flattens and spreads to cover the gap to its neighbour, which is
       * why a real satin column reads as a solid mass with fine striations
       * rather than as a picket fence. Drawing the nominal width leaves the
       * fabric showing through between strands whenever the density is set
       * looser than the thread is thick.
       *
       * So the width follows the MEASURED spacing of this block's own
       * stitches — median, not mean, because the first and last stitch of
       * every run are irregular and a mean lets them drag the whole column.
       */
      const gaps: number[] = []
      for (let i = 1; i < segs.length; i++) {
        const [ax, ay, bx, by] = segs[i - 1]
        const [cx, cy, dx2, dy2] = segs[i]
        // ACROSS the stitch, not between midpoints.
        //
        // The distance between two stitch midpoints answers a different
        // question depending on what is being sewn, and taking it as the
        // lay-down spacing was catastrophic on fills. In a satin column
        // consecutive bars are parallel and step along the spine, so the
        // midpoints really are one density apart — about 0.4 mm. In a tatami
        // fill consecutive stitches run END TO END along the same row, so
        // their midpoints are a stitch LENGTH apart — about 4 mm, ten times
        // too much. Every stitch was then drawn ten times too wide, which is
        // why a filled letter came out as a pile of bricks.
        //
        // The perpendicular component asks the question that was meant: how
        // far is the next stitch displaced ACROSS this one. Along a fill row
        // that is zero, between rows it is the row spacing, and in a satin
        // column it is the density — the right answer in all three.
        let ux = bx - ax, uy = by - ay
        const ulen = Math.hypot(ux, uy)
        if (ulen < 1e-6) continue
        ux /= ulen; uy /= ulen
        const mx = (cx + dx2) / 2 - (ax + bx) / 2
        const my = (cy + dy2) / 2 - (ay + by) / 2
        gaps.push(Math.abs(mx * -uy + my * ux))
      }
      // IGNORE THE ZEROS FIRST. In a satin column every consecutive pair is
      // displaced across by one density, so the median of all gaps is the
      // density and all is well. In a TATAMI FILL most consecutive stitches
      // run end to end along the same ROW — perpendicular displacement zero
      // — and only the row turns carry the row spacing. The median of mostly
      // zeros is zero, so lay collapsed to the nominal 0.4 mm thread, the
      // rows never touched, and a filled letter came out as a picket fence
      // with the fabric showing between every row.
      //
      // What is wanted is the spacing BETWEEN rows, which is what the
      // non-zero gaps measure. Thread under tension flattens to cover it.
      const spread = gaps.filter((g) => g > threadPx * 0.3).sort((a, b) => a - b)
      // Median of those, not mean: the first and last stitch of every run is
      // irregular and a mean lets them drag the whole block.
      const spacing = spread.length ? spread[spread.length >> 1] : 0
      // Capped at twice the thread, not four times. Thread laid under tension
      // flattens and spreads a little to cover the gap to its neighbour, but
      // it does not spread without limit — past about double, what is being
      // drawn is no longer thread.
      const lay = Math.max(threadPx, Math.min(spacing * 1.35, threadPx * 2))

      // BUTT caps. The argument for round was that at a true thread width a
      // round cap is just the end of a cord — true of ONE stitch, and wrong
      // for a column of them: every bar end adds a half-disc, and a few
      // hundred of those down an edge is a scallop. Side by side with a
      // reference rendering ours had chewed outlines and theirs were
      // straight, which is the whole difference. v2 said butt; v2 was right.
      ctx.lineCap = 'butt'
      ctx.lineJoin = 'round'

      /**
       * One shading pass.
       *
       * `span` shortens each stitch about its own midpoint. THIS IS WHAT
       * MAKES IT LOOK LIKE THREAD. A stitch dips into the cloth at both ends
       * and lies proud in the middle, so it is dark where it enters and
       * bright along its crown — and the banding in real satin therefore runs
       * PERPENDICULAR to the stitches. Drawing all three passes at full
       * length, as this did, gives every stitch one flat colour end to end,
       * and a column of them reads as poster paint.
       */
      // Does this stitch END where the next one BEGINS? Shortening a stitch
      // is only right where it really stops — at the edge of a satin column,
      // where the thread dips into the cloth. A tatami row and a running
      // stitch are chains of stitches laid END TO END, and pulling each one
      // in leaves a dark notch at every junction: the fill came out dashed
      // and the run came out as a string of sausages.
      const JOIN_PX = Math.max(0.6, threadPx * 0.5)
      const joins: boolean[] = []
      for (let i = 0; i < segs.length; i++) {
        const n = segs[i + 1]
        joins.push(!!n && Math.hypot(n[0] - segs[i][2], n[1] - segs[i][3]) <= JOIN_PX)
      }

      const pass = (colour: string, width: number, alpha: number, span: number) => {
        ctx.strokeStyle = colour
        ctx.lineWidth = Math.max(0.35, width)
        ctx.globalAlpha = alpha
        ctx.beginPath()
        const trim = (1 - span) / 2
        for (let i = 0; i < segs.length; i++) {
          const [x0, y0, x1, y1] = segs[i]
          // Only a FREE end is pulled in. A joined one runs to the meeting
          // point so the two stitches meet with no gap between them.
          const t0 = (i > 0 && joins[i - 1]) ? 0 : trim
          const t1 = joins[i] ? 0 : trim
          if (t0 === 0 && t1 === 0) {
            ctx.moveTo(x0, y0)
            ctx.lineTo(x1, y1)
          } else {
            const dx = x1 - x0, dy = y1 - y0
            ctx.moveTo(x0 + dx * t0, y0 + dy * t0)
            ctx.lineTo(x1 - dx * t1, y1 - dy * t1)
          }
        }
        ctx.stroke()
      }

      // Shadow first, spreading under the neighbours so rows merge into one
      // surface instead of standing apart as separate bars. Then the cord,
      // pulled in slightly so each stitch darkens where it enters the cloth,
      // then the crown over the middle half only.
      pass(shade(b.color, SHADOW_T), lay * SHADOW_W, SHADOW_A, 1)
      pass(b.color, lay * CORD_W, CORD_A, BODY_SPAN)
      pass(shade(b.color, CROWN_T), lay * CROWN_W, CROWN_A, CROWN_SPAN)
      ctx.globalAlpha = 1
      // Put the cap back. Everything drawn after this — jumps, trims, the
      // density overlay, selection furniture — wants round ends, and a butt
      // cap left set leaks into all of it. v2 recorded this; it is only not
      // a bug today because the previous value happened to match the default.
      ctx.lineCap = 'round'
    }

    if (opt.showJumps) {
      ctx.strokeStyle = dark ? '#8b5cf6' : '#b91c1c'
      ctx.lineWidth = 1
      ctx.setLineDash([2, 3])
      let n = 0
      for (const b of plan.blocks) {
        let prev: Pt | null = null
        for (const s of b.stitches) {
          if (n++ >= limit) break
          if (s.jump && prev) {
            const a = toS(prev), c = toS(s)
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke()
          }
          prev = s
        }
      }
      ctx.setLineDash([])
    }

    if (opt.showPoints && view.scale > 3) {
      ctx.fillStyle = dark ? '#e5e7eb' : '#111827'
      let n = 0
      for (const b of plan.blocks) {
        for (const s of b.stitches) {
          if (n++ >= limit) break
          if (s.jump) continue
          const p = toS(s)
          ctx.fillRect(p.x - 0.75, p.y - 0.75, 1.5, 1.5)
        }
      }
    }
  }

  // --- picked stitches -------------------------------------------------------
  if (opt.picked && opt.picked.length) {
    ctx.save()
    ctx.fillStyle = '#22d3ee'
    ctx.strokeStyle = dark ? '#0f1216' : '#ffffff'
    ctx.lineWidth = 1
    for (const r of opt.picked) {
      const st = plan.blocks[r.block]?.stitches[r.index]
      if (!st) continue
      const p = toS(st)
      ctx.beginPath()
      ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
    ctx.restore()
  }

  // --- density heat ----------------------------------------------------------
  // Over the stitches, because the point is to show WHERE in the design the
  // trouble is. Only the cells past the threshold are painted: shading
  // everything would be a picture of the design, not a diagnostic.
  if (opt.density && opt.density.cells.length) {
    ctx.save()
    for (const c of opt.density.cells) {
      const fill = densityColour(c.ratio)
      if (!fill) continue
      const a = toS({ x: c.x, y: c.y })
      const b = toS({ x: c.x + opt.density.cellMm, y: c.y + opt.density.cellMm })
      ctx.fillStyle = fill
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y)
    }
    ctx.restore()
  }

  // --- start and end markers ------------------------------------------------
  // Green starts, red ends — the one colour pairing nobody has to be taught.
  // Drawn after the stitches for the same reason the letter grips are: they
  // sit on the object they belong to.
  if (opt.endpoints) {
    const dot = (at: Pt, fill: string, label: string) => {
      const p = toS(at)
      ctx.beginPath()
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2)
      ctx.fillStyle = fill
      ctx.fill()
      ctx.strokeStyle = dark ? '#0f1216' : '#ffffff'
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.fillStyle = dark ? '#e5e7eb' : '#111827'
      ctx.font = '10px system-ui, sans-serif'
      ctx.fillText(label, p.x + 8, p.y + 3)
    }
    ctx.save()
    if (opt.endpoints.entry) dot(opt.endpoints.entry, '#22c55e', 'start')
    if (opt.endpoints.exit) dot(opt.endpoints.exit, '#ef4444', 'end')
    ctx.restore()
  }

  // --- satin angle guides ---------------------------------------------------
  // Amber, dashed, with a tick at each end: they are an INSTRUCTION about the
  // stitching rather than part of the artwork, and must not read as another
  // outline. The one being dragged is drawn solid so it is obvious which is
  // live.
  if (opt.guides && (opt.guides.lines.length || opt.guides.draft)) {
    ctx.save()
    ctx.lineCap = 'round'
    const bar = (g: { a: Pt; b: Pt }, live: boolean) => {
      const a = toS(g.a), b = toS(g.b)
      ctx.strokeStyle = live ? '#f59e0b' : 'rgba(245,158,11,0.85)'
      ctx.lineWidth = live ? 2 : 1.6
      ctx.setLineDash(live ? [] : [5, 3])
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
      // End ticks, so a guide reads as a bar with two ends rather than as a
      // stray line someone drew across the design.
      ctx.setLineDash([])
      ctx.lineWidth = 2
      for (const p of [a, b]) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.stroke()
      }
    }
    for (const g of opt.guides.lines) bar(g, false)
    if (opt.guides.draft) bar(opt.guides.draft, true)
    ctx.restore()
  }

  // --- per-letter grips ------------------------------------------------------
  // Green, and square like the resize handles but a different colour: they
  // move ONE letter rather than the whole object, and that distinction has to
  // survive being seen out of the corner of an eye.
  //
  // Drawn AFTER the stitches. A grip sits in the middle of its letter, which
  // is the densest part of the stitching — drawn before, every one of them
  // disappeared under the thread it was meant to label.
  if (opt.letterHandles) {
    ctx.save()
    ctx.fillStyle = '#22c55e'
    ctx.strokeStyle = dark ? '#0f1216' : '#ffffff'
    ctx.lineWidth = 1.5
    // Big enough to hit on the first try. These sit INSIDE the selection box
    // and on top of stitching, so a small marker is both hard to see against
    // a busy fill and hard to land on — and the gesture they start is a fine
    // positional nudge, where fighting for the grab is the whole frustration.
    const r = LETTER_HANDLE_PX / 2
    for (const c of opt.letterHandles) {
      const p = toS(c)
      // A soft shadow so it reads on top of dense thread of any colour.
      ctx.shadowColor = 'rgba(0,0,0,0.55)'
      ctx.shadowBlur = 3
      ctx.beginPath()
      ctx.rect(p.x - r, p.y - r, LETTER_HANDLE_PX, LETTER_HANDLE_PX)
      ctx.fill()
      ctx.shadowBlur = 0
      ctx.stroke()
    }
    ctx.restore()
  }

  // --- rulers -------------------------------------------------------------
  ctx.fillStyle = dark ? '#1b1f26' : '#efe9d4'
  ctx.fillRect(0, 0, W, RULER)
  ctx.fillRect(0, 0, RULER, H)
  ctx.strokeStyle = dark ? '#333b45' : '#c3bba1'
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(0, RULER + 0.5); ctx.lineTo(W, RULER + 0.5); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(RULER + 0.5, 0); ctx.lineTo(RULER + 0.5, H); ctx.stroke()

  ctx.fillStyle = ink
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textBaseline = 'top'

  // Inch ticks, with eighths when there is room.
  const inchPx = MM_PER_IN * view.scale
  const sub = inchPx > 80 ? 8 : inchPx > 40 ? 4 : inchPx > 20 ? 2 : 1
  const firstIn = Math.floor(screenToWorld(view, W, H, { x: RULER, y: 0 }).x / MM_PER_IN) - 1
  const lastIn = Math.ceil(screenToWorld(view, W, H, { x: W, y: 0 }).x / MM_PER_IN) + 1
  for (let i = firstIn * sub; i <= lastIn * sub; i++) {
    const x = toS({ x: (i / sub) * MM_PER_IN, y: 0 }).x
    if (x < RULER) continue
    const major = i % sub === 0
    ctx.strokeStyle = ink
    ctx.globalAlpha = major ? 0.9 : 0.4
    ctx.beginPath()
    ctx.moveTo(Math.round(x) + 0.5, major ? 8 : 15)
    ctx.lineTo(Math.round(x) + 0.5, RULER)
    ctx.stroke()
    ctx.globalAlpha = 1
    if (major) ctx.fillText(String(i / sub), Math.round(x) + 2, 0)
  }
  const firstY = Math.floor(screenToWorld(view, W, H, { x: 0, y: RULER }).y / MM_PER_IN) - 1
  const lastY = Math.ceil(screenToWorld(view, W, H, { x: 0, y: H }).y / MM_PER_IN) + 1
  for (let i = firstY * sub; i <= lastY * sub; i++) {
    const y = toS({ x: 0, y: (i / sub) * MM_PER_IN }).y
    if (y < RULER) continue
    const major = i % sub === 0
    ctx.strokeStyle = ink
    ctx.globalAlpha = major ? 0.9 : 0.4
    ctx.beginPath()
    ctx.moveTo(major ? 8 : 15, Math.round(y) + 0.5)
    ctx.lineTo(RULER, Math.round(y) + 0.5)
    ctx.stroke()
    ctx.globalAlpha = 1
    // Ruler reads like a drawing board: up is positive, so the sign flips.
    if (major) ctx.fillText(String(-i / sub), 2, Math.round(y) + 2)
  }
  ctx.fillStyle = dark ? '#1b1f26' : '#efe9d4'
  ctx.fillRect(0, 0, RULER, RULER)
}
