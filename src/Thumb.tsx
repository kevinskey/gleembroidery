// A thumbnail of one object, drawn in place.
//
// The point is not decoration. A list that reads "Column, Column, Column,
// Fill, Fill" tells you the order but not WHAT each row is, and on a design
// with two dozen rows that is the only thing you want to know — which one is
// a petal and which is the lettering.
//
// Every thumbnail is drawn against the WHOLE DESIGN's bounds, not its own.
// That is what makes them read as layers of one picture rather than as two
// dozen unrelated shapes: a leaf appears low and left in its frame and the
// arched lettering across the top, exactly where they are on the garment.

import { useEffect, useRef } from 'react'
import type { Pt } from './model'

export interface ThumbBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function Thumb({
  paths, bounds, color, size = 24, dim = false, outline = false,
}: {
  paths: readonly Pt[][]
  /** The whole design's extent, so every thumbnail shares one frame. */
  bounds: ThumbBounds | null
  color: string
  size?: number
  /** Drawn faintly — the object is hidden, or in a hidden group. */
  dim?: boolean
  /** Stroke rather than fill, for shapes with no inside. */
  outline?: boolean
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size, size)
    if (!bounds || !paths.length) return

    const w = Math.max(1e-6, bounds.maxX - bounds.minX)
    const h = Math.max(1e-6, bounds.maxY - bounds.minY)
    const pad = 1.5
    const scale = Math.min((size - pad * 2) / w, (size - pad * 2) / h)
    const ox = (size - w * scale) / 2 - bounds.minX * scale
    const oy = (size - h * scale) / 2 - bounds.minY * scale

    ctx.globalAlpha = dim ? 0.3 : 1
    ctx.beginPath()
    for (const ring of paths) {
      if (ring.length < 2) continue
      ctx.moveTo(ring[0].x * scale + ox, ring[0].y * scale + oy)
      for (let i = 1; i < ring.length; i++) {
        ctx.lineTo(ring[i].x * scale + ox, ring[i].y * scale + oy)
      }
    }
    if (outline) {
      ctx.strokeStyle = color
      // At this size a whole design is a couple of dozen pixels, so a line
      // has to be the thinnest mark that still shows.
      ctx.lineWidth = 1
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.stroke()
    } else {
      ctx.fillStyle = color
      // EVEN-ODD, so a counter stays a hole. A filled O that came out solid
      // would be the one thumbnail you could not identify.
      ctx.fill('evenodd')
      // A hairline of the same colour so a very thin shape — a stem, a
      // serif — does not vanish at this size.
      ctx.strokeStyle = color
      ctx.lineWidth = 0.6
      ctx.stroke()
    }
  }, [paths, bounds, color, size, dim, outline])

  return <canvas className="thumb" ref={ref} style={{ width: size, height: size }} />
}
