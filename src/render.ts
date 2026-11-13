// Canvas rendering: hoop, rulers, artwork outlines and the stitch plan.
//
// World units are mm with the ORIGIN AT THE HOOP CENTRE and +Y down, which
// matches both the document and the way a machine is set up — the operator
// centres the hoop and the design grows out from there.

import type { Doc, Pt } from './model'
import { handlesOf, type Shape } from './nodes'
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
  /** Selection bounds to draw resize handles on. */
  selectionBox?: { minX: number; minY: number; maxX: number; maxY: number } | null
  /** Editable outlines to draw nodes and Bézier handles for. */
  nodeEdit?: { shapes: readonly Shape[]; active?: { s: number; i: number } | null } | null
  /** Px above the selection to put the rotation grip; omit to hide it. */
  rotateOffsetPx?: number
  /** Rubber band being dragged over empty space. */
  marquee?: { a: Pt; b: Pt } | null
  /** Reference image drawn behind everything, for tracing over. */
  backdrop?: { bitmap: CanvasImageSource; origin: Pt; widthMm: number; heightMm: number } | null
}

const RULER = 22 // px gutter for the rulers

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

  ctx.fillStyle = dark ? '#0f1216' : '#e8e4d6'
  ctx.fillRect(0, 0, W, H)

  const toS = (p: Pt) => worldToScreen(view, W, H, p)

  // --- hoop ---------------------------------------------------------------
  const hw = doc.hoop.widthMm / 2, hh = doc.hoop.heightMm / 2
  const tl = toS({ x: -hw, y: -hh }), br = toS({ x: hw, y: hh })
  ctx.fillStyle = paper
  ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y)

  // --- grid ---------------------------------------------------------------
  if (opt.showGrid) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y)
    ctx.clip()
    ctx.strokeStyle = dark ? '#2a3038' : '#cfc8ae'
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
  ctx.strokeStyle = dark ? '#4b5563' : '#8a8268'
  ctx.lineWidth = 1
  ctx.setLineDash([6, 4])
  const o = toS({ x: 0, y: 0 })
  ctx.beginPath(); ctx.moveTo(tl.x, Math.round(o.y) + 0.5); ctx.lineTo(br.x, Math.round(o.y) + 0.5); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(Math.round(o.x) + 0.5, tl.y); ctx.lineTo(Math.round(o.x) + 0.5, br.y); ctx.stroke()
  ctx.setLineDash([])

  // Hoop edge.
  ctx.strokeStyle = dark ? '#6b7280' : '#8a7a4a'
  ctx.lineWidth = 2
  ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y)

  // --- reference design loaded from a file --------------------------------
  if (opt.reference) {
    ctx.lineWidth = 1
    ctx.strokeStyle = dark ? '#3f4752' : '#b9b19a'
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
      ctx.setLineDash([])
      ctx.fillStyle = '#1f9cf0'
      for (const q of path) { const p = toS(q); ctx.fillRect(p.x - 2, p.y - 2, 4, 4) }
      ctx.setLineDash([5, 3])
    }
    ctx.restore()
  }

  // --- stitches -----------------------------------------------------------
  if (opt.showStitches) {
    let drawn = 0
    const limit = opt.upTo ?? Infinity
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const b of plan.blocks) {
      ctx.strokeStyle = b.color
      // A thread is about 0.4 mm across; never thinner than a hairline.
      ctx.lineWidth = Math.max(0.8, 0.4 * view.scale)
      ctx.beginPath()
      let pen = false
      for (const s of b.stitches) {
        if (drawn >= limit) break
        drawn++
        const p = toS(s)
        if (s.jump) { pen = false; continue }
        if (!pen) { ctx.moveTo(p.x, p.y); pen = true } else ctx.lineTo(p.x, p.y)
      }
      ctx.stroke()
      if (drawn >= limit) break
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
