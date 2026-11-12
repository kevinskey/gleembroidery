import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { centerPlan } from './digitize'
import { readDst, writeDst } from './dst'
import { close, toRegions } from './geometry'
import { useHistory } from './history'
import { bigEnough, ellipsePath, freehandPath, polygonUsable, rectPath } from './draw'
import {
  fitPaths, handleCursor, hitHandle, movePaths, objectBox, pickObject, resizeBox,
  type Box, type Handle,
} from './transform'
import {
  HOOPS,
  SPACINGS,
  bounds,
  emptyDoc,
  hoopsForSpacing,
  newObject,
  type Doc,
  type EmbObject,
  type Pt,
  type Spacing,
  type StitchType,
} from './model'
import {
  DEFAULT_MACHINE,
  packageStats,
  placementTemplateSvg,
  runSheetHtml,
  writeCol,
  writeEdr,
  type MachineProfile,
} from './package'
import { FILE_EXT, ProjectError, deserialize, projectFilename, serialize } from './project'
import { fitView, render, screenToWorld, type RenderOptions, type View } from './render'
import { countStitches, longestStitch, planBounds, type StitchPlan } from './stitches'
import { useStitchPlan } from './useStitchPlan'
import { parseSvgToPaths } from './vector'

// Thread colours for freshly imported shapes — spaced around the wheel so
// adjacent objects are told apart at a glance before the user sets real ones.
const PALETTE = ['#c0392b', '#1f6feb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#1f2d3d']

/** Grab radius for a resize handle and for picking an object, screen px.
 *  Screen-constant on purpose: a tolerance in mm would be unusably tiny when
 *  zoomed out and absurdly fat when zoomed in. */
const HANDLE_PX = 6
const PICK_PX = 4

/** Where in-progress work is parked so a reload does not lose it. */
const AUTOSAVE_KEY = 'gleembroidery.autosave.v1'

/** Canvas tools. 'select' picks/moves/resizes; empty space still pans. */
type Tool = 'select' | 'rect' | 'ellipse' | 'polygon' | 'freehand'

const TOOLS: { id: Tool; label: string; hint: string; icon: ReactElement }[] = [
  {
    id: 'select', label: 'Select', hint: 'Click an object to select it, drag to move, drag a handle to resize. Shift keeps the proportions. Drag empty space to pan. (V)',
    icon: (
      <svg width="22" height="16" viewBox="0 0 22 16"><path d="M8 2l6 6-2.5.7L13 12l-1.8.8-1.5-3.3L8 11.5z" fill="currentColor" /></svg>
    ),
  },
  {
    id: 'rect', label: 'Rect', hint: 'Drag a rectangle — hold Shift for a square (R)',
    icon: (
      <svg width="22" height="16" viewBox="0 0 22 16"><rect x="3.5" y="3.5" width="15" height="9" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
    ),
  },
  {
    id: 'ellipse', label: 'Ellipse', hint: 'Drag an ellipse — hold Shift for a circle (E)',
    icon: (
      <svg width="22" height="16" viewBox="0 0 22 16"><ellipse cx="11" cy="8" rx="7.5" ry="4.5" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
    ),
  },
  {
    id: 'polygon', label: 'Polygon', hint: 'Click each corner; double-click or Enter to finish, Esc to cancel (P)',
    icon: (
      <svg width="22" height="16" viewBox="0 0 22 16"><path d="M11 2.5l7.5 5.5-3 6h-9l-3-6z" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
    ),
  },
  {
    id: 'freehand', label: 'Draw', hint: 'Drag to draw freely; end near the start to close a shape (D)',
    icon: (
      <svg width="22" height="16" viewBox="0 0 22 16"><path d="M2 12c4-9 7 5 10-1s5 1 8-3" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
    ),
  },
]

const TYPES: { id: StitchType; label: string; hint: string; icon: ReactElement }[] = [
  {
    id: 'run', label: 'Run', hint: 'Single running stitch along the path',
    icon: (
      <svg width="22" height="16" viewBox="0 0 22 16"><path d="M1 8h20" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" fill="none" /></svg>
    ),
  },
  {
    id: 'bean', label: 'Bean', hint: 'Triple-pass run — a bold outline',
    icon: (
      <svg width="22" height="16" viewBox="0 0 22 16"><path d="M1 8h20" stroke="currentColor" strokeWidth="3" fill="none" /></svg>
    ),
  },
  {
    id: 'satin', label: 'Satin', hint: 'Zigzag column centred on the path',
    icon: (
      <svg width="22" height="16" viewBox="0 0 22 16"><path d="M1 13L4 3L7 13L10 3L13 13L16 3L19 13L21 6" stroke="currentColor" strokeWidth="1.3" fill="none" /></svg>
    ),
  },
  {
    id: 'fill', label: 'Fill', hint: 'Tatami fill of the enclosed area',
    icon: (
      <svg width="22" height="16" viewBox="0 0 22 16">
        <rect x="1.5" y="2.5" width="19" height="11" stroke="currentColor" strokeWidth="1" fill="none" />
        {[4, 6, 8, 10, 12].map((y) => <path key={y} d={`M2 ${y}h18`} stroke="currentColor" strokeWidth="0.8" opacity="0.7" />)}
      </svg>
    ),
  },
  {
    id: 'none', label: 'Off', hint: 'Construction only — stitches nothing',
    icon: (
      <svg width="22" height="16" viewBox="0 0 22 16"><path d="M4 4l14 8M18 4L4 12" stroke="currentColor" strokeWidth="1.3" fill="none" /></svg>
    ),
  },
]

function Num({ label, value, step = 0.1, min, max, onChange }: {
  label: string; value: number; step?: number; min?: number; max?: number; onChange: (v: number) => void
}) {
  return (
    <div className="row">
      <label>{label}</label>
      <input
        type="number" value={value} step={step} min={min} max={max}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (!Number.isNaN(v)) onChange(v)
        }}
      />
    </div>
  )
}

function Text({ label, value, placeholder, onChange }: {
  label: string; value: string; placeholder?: string; onChange: (v: string) => void
}) {
  return (
    <div className="row">
      <label>{label}</label>
      <input type="text" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

// A file-picker button.
//
// This is a <label> that LOOKS like a button, not a <button> that calls
// input.click(). That distinction is the whole point: the old version was
// `<label><button onClick={input.click()}/><input type="file" hidden/></label>`,
// and `hidden` means display:none — WebKit refuses to open the picker for a
// programmatic click on a file input that is display:none, so on Safari the
// Import SVG button did nothing at all, silently. Chrome allowed it, which is
// why it looked fine in testing.
//
// Native label-to-input activation needs no script and works everywhere, so
// the input is visually hidden by clipping (still rendered, still focusable)
// rather than removed from the box tree.
function FilePick({ label, accept, onPick }: {
  label: string; accept: string; onPick: (f: File) => void;
}) {
  return (
    <label className="filepick" tabIndex={0}
      onKeyDown={(e) => {
        // A label is not natively keyboard-activatable; forward Enter/Space to
        // the input so the control is still reachable without a mouse.
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.currentTarget.querySelector('input')?.click()
        }
      }}>
      {label}
      <input type="file" accept={accept} className="visually-hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = '' }} />
    </label>
  )
}

export default function App() {
  // The document lives behind an undo stack. `setDoc` records a step;
  // history.begin()/end() collapse a drag into one; a `tag` coalesces rapid
  // edits to the same field. See history.ts.
  const history = useHistory<Doc>(emptyDoc)
  const doc = history.state
  const setDoc = history.set
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<View>({ scale: 3, cx: 0, cy: 0 })
  const [reference, setReference] = useState<StitchPlan | null>(null)
  const [sim, setSim] = useState<number | null>(null)
  const [machine, setMachine] = useState<MachineProfile>(DEFAULT_MACHINE)
  const [note, setNote] = useState<string | null>(null)
  const [opts, setOpts] = useState<Omit<RenderOptions, 'upTo' | 'selectedId' | 'reference' | 'draft' | 'selectionBox'>>({
    showGrid: true, showArt: true, showStitches: true, showPoints: false, showJumps: true,
  })

  const [tool, setTool] = useState<Tool>('select')
  // Geometry being dragged out right now, in mm. Drawn as a dashed preview and
  // held OUTSIDE the document so an abandoned drag leaves nothing behind.
  const [draft, setDraft] = useState<{ paths: Pt[][]; closed: boolean } | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const panning = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null)
  // Drag in progress for the shape tools: where it started, and the live trail
  // for freehand. A ref, not state — this updates on every mousemove and must
  // not re-render the toolbar.
  const dragging = useRef<{ from: Pt; trail: Pt[] } | null>(null)
  // Polygon vertices committed by clicks so far.
  const polyPts = useRef<Pt[]>([])
  // A move or resize in flight. Holds the object's ORIGINAL geometry so every
  // frame recomputes from it — and so Escape can put it back, which is the
  // only safety net here until there is an undo stack.
  const xform = useRef<
    { kind: 'move' | 'resize'; handle?: Handle; from: Box; start: Pt; paths: Pt[][]; id: string } | null
  >(null)
  const [hoverCursor, setHoverCursor] = useState<string | null>(null)

  // Generation runs in a worker, keyed to the document revision, so a slow
  // result can never land on top of a newer edit.
  const { plan, warnings, busy, ms, inline } = useStitchPlan(doc)
  const counts = useMemo(() => countStitches(plan), [plan])
  const pb = useMemo(() => planBounds(plan), [plan])
  const total = counts.stitches + counts.jumps
  const stats = useMemo(() => packageStats(doc, plan, warnings, machine), [doc, plan, warnings, machine])

  const selected = doc.objects.find((o) => o.id === selectedId) ?? null

  // Hoops whose arms fit this machine's bracket. Non-mountable sizes stay
  // visible but disabled, so the operator learns the constraint instead of
  // wondering why a hoop they own is missing from the list.
  const mountable = useMemo(
    () => new Set(hoopsForSpacing(doc.spacing).map((h) => h.name)),
    [doc.spacing],
  )

  // --- rendering ----------------------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const dpr = window.devicePixelRatio || 1
    const w = wrap.clientWidth, h = wrap.clientHeight
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    render(ctx, doc, plan, view, {
      ...opts, upTo: sim ?? undefined, selectedId, reference, draft,
      // Handles only in the select tool — they are not grabbable otherwise,
      // and drawing them would promise an interaction that is not there.
      selectionBox: tool === 'select' && selected ? objectBox(selected) : null,
    })
  }, [doc, plan, view, opts, sim, selectedId, reference, draft, tool, selected])

  useEffect(() => { draw() }, [draw])

  useEffect(() => {
    const ro = new ResizeObserver(() => draw())
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [draw])

  const fit = useCallback(() => {
    const wrap = wrapRef.current
    if (wrap) setView(fitView(doc, wrap.clientWidth, wrap.clientHeight))
  }, [doc])

  // --- autosave -----------------------------------------------------------
  // Explicit Save writes a file; this exists only so a refresh or a crash
  // does not lose work in progress. Restored once, on mount, and said out loud.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(AUTOSAVE_KEY)
      if (saved) {
        const restored = deserialize(saved)
        if (restored.objects.length) {
          history.reset(restored)
          setSelectedId(restored.objects[0].id)
          setNote('Restored unsaved work from your last session')
        }
      }
    } catch (e) {
      // NEVER destroy an autosave because we could not read it. It is by
      // definition the only copy of unsaved work, and the commonest reason
      // for the failure is a file from a NEWER build — exactly the case the
      // version gate exists to protect. Set it aside and say so.
      try {
        const orphan = localStorage.getItem(AUTOSAVE_KEY)
        if (orphan) {
          localStorage.setItem(`${AUTOSAVE_KEY}.unreadable.${Date.now()}`, orphan)
          localStorage.removeItem(AUTOSAVE_KEY)
        }
      } catch {
        // Nothing more we can do; leave it where it is.
      }
      setNote(
        `Could not restore your last session (${(e as Error).message}). ` +
          'It has been kept aside, not deleted.',
      )
    }
    setTimeout(fit, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        if (doc.objects.length) localStorage.setItem(AUTOSAVE_KEY, serialize(doc))
        else localStorage.removeItem(AUTOSAVE_KEY)
      } catch {
        // Out of quota. Clear the slot rather than leave a smaller, OLDER
        // autosave behind to be restored later as if it were current.
        try { localStorage.removeItem(AUTOSAVE_KEY) } catch { /* ignore */ }
        setNote('This design is too large to autosave — use Save to keep it.')
      }
    }, 600)
    return () => clearTimeout(t)
  }, [doc])

  // --- document edits -----------------------------------------------------
  // `tag` groups rapid edits to the SAME field into one undo step — typing
  // "12.5" into a box is one action, not four.
  const patch = (id: string, fn: (o: EmbObject) => EmbObject, tag?: string) =>
    setDoc((d) => ({ ...d, objects: d.objects.map((o) => (o.id === id ? fn(o) : o)) }),
      tag && `${tag}:${id}`)

  const addPaths = (paths: Pt[][], label: string) => {
    // Split into regions so a letter keeps its counter as a hole of the SAME
    // object, while separate shapes become separate objects the user can
    // colour and treat independently.
    const regions = toRegions(paths)
    const groups: Pt[][][] = regions.length ? regions : [paths]
    const b = bounds(paths)
    const dx = b ? -(b.minX + b.maxX) / 2 : 0
    const dy = b ? -(b.minY + b.maxY) / 2 : 0
    const made = groups.map((g, i) =>
      newObject({
        name: groups.length > 1 ? `${label} ${i + 1}` : label,
        color: PALETTE[i % PALETTE.length],
        type: 'fill',
        paths: g.map((ring) => [...ring, ring[0]].map((p) => ({ x: p.x + dx, y: p.y + dy }))),
      }),
    )
    setDoc((d) => ({ ...d, objects: [...d.objects, ...made] }))
    setSelectedId(made[0]?.id ?? null)
    setSim(null)
  }

  /**
   * Add a shape the user just drew.
   *
   * Deliberately NOT addPaths: that recentres the import on the hoop, which is
   * right for a file arriving in unknown coordinates and badly wrong for a
   * shape drawn at a chosen spot — the shape would jump to the middle the
   * instant the mouse came up. Drawn geometry is already in document mm, so it
   * is kept exactly where it was put.
   */
  // Depends on the object COUNT, and every memoised caller depends on this in
  // turn. That chain is load-bearing: when finishPolygon memoised with an
  // empty dep list it kept the first addDrawn forever, and named a shape
  // "Polygon 1" on a document that already held two objects. The count is
  // read here rather than inside the setDoc updater because an updater must
  // stay a pure function — React may run it twice.
  const addDrawn = useCallback((paths: Pt[][], closed: boolean, label: string) => {
    const n = doc.objects.length
    const obj = newObject({
      name: `${label} ${n + 1}`,
      color: PALETTE[n % PALETTE.length],
      // An open path cannot be filled; a closed one usually wants to be.
      type: closed ? 'fill' : 'run',
      paths: paths.map((p) => (closed ? close(p) : p)),
    })
    setDoc((d) => ({ ...d, objects: [...d.objects, obj] }))
    setSelectedId(obj.id)
    setSim(null)
  }, [doc.objects.length])

  const importSvg = async (file: File) => {
    try {
      const v = parseSvgToPaths(await file.text(), file.name.replace(/\.svg$/i, ''))
      addPaths(v.paths, v.name)
      setNote(v.skipped
        ? `${v.skipped} element(s) skipped — convert text to outlines first`
        : `Imported ${v.name}`)
      setTimeout(fit, 0)
    } catch (e) {
      alert(`Could not read that SVG: ${(e as Error).message}`)
    }
  }

  const importDstReference = async (file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const d = readDst(bytes)
      setReference({
        blocks: d.blocks.map((b, i) => ({ color: PALETTE[i % PALETTE.length], label: `Colour ${i + 1}`, stitches: b.stitches })),
      })
      const w = d.extents.maxX - d.extents.minX, h = d.extents.maxY - d.extents.minY
      setNote(
        `${file.name}: ${d.stitchCount} stitches, ${d.colorChanges + 1} colour block(s), ` +
          `${w.toFixed(1)} × ${h.toFixed(1)} mm — shown as a grey reference`,
      )
    } catch (e) {
      alert(`Could not read that DST: ${(e as Error).message}`)
    }
  }

  // --- output -------------------------------------------------------------
  const download = (name: string, data: string | Uint8Array, type = 'application/octet-stream') => {
    const a = document.createElement('a')
    // Uint8Array is a valid BlobPart at runtime; the DOM lib types BlobPart
    // against ArrayBuffer specifically, which a generic Uint8Array misses.
    a.href = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type }))
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  }

  const base = () => (doc.name || 'design').replace(/[^\w\-. ]+/g, '_').trim() || 'design'

  /**
   * Export the production PACKAGE, not just the machine file. A bare .dst
   * carries no colour at all, so on its own it hands the operator a stack of
   * unlabelled blocks and asks them to guess.
   */
  const exportPackage = () => {
    if (!total) return
    const centered = centerPlan(plan)
    const n = base()
    download(`${n}.dst`, writeDst(centered, n))
    download(`${n}.col`, writeCol(centered), 'text/plain')
    download(`${n}.edr`, writeEdr(centered))
    download(`${n}-template.svg`, placementTemplateSvg(doc, centered), 'image/svg+xml')
    const sheet = window.open('', '_blank')
    if (sheet) {
      sheet.document.write(runSheetHtml(doc, stats, machine))
      sheet.document.close()
    } else {
      download(`${n}-runsheet.html`, runSheetHtml(doc, stats, machine), 'text/html')
    }
    setNote(`Exported ${n}.dst + colour sidecars, run sheet and 1:1 template`)
  }

  const exportDstOnly = () => {
    if (!total) return
    download(`${base()}.dst`, writeDst(centerPlan(plan), base()))
    setNote('Exported the .dst only — no colour information travels with a DST')
  }

  const saveProject = () => {
    download(projectFilename(doc), serialize(doc, true), 'application/json')
    setNote(`Saved ${projectFilename(doc)}`)
  }

  const openProject = async (file: File) => {
    try {
      const loaded = deserialize(await file.text())
      history.reset(loaded)
      setSelectedId(loaded.objects[0]?.id ?? null)
      setSim(null)
      setTimeout(fit, 0)
      setNote(`Opened ${file.name} — ${loaded.objects.length} object(s)`)
    } catch (e) {
      alert(e instanceof ProjectError ? e.message : `Could not open that project: ${(e as Error).message}`)
    }
  }

  // --- canvas interaction -------------------------------------------------
  const onWheel = (e: React.WheelEvent) => {
    const wrap = wrapRef.current
    if (!wrap) return
    const rect = wrap.getBoundingClientRect()
    const at = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const before = screenToWorld(view, rect.width, rect.height, at)
    const scale = Math.max(0.3, Math.min(60, view.scale * Math.exp(-e.deltaY * 0.0015)))
    const after = screenToWorld({ ...view, scale }, rect.width, rect.height, at)
    // Keep the point under the cursor pinned while zooming.
    setView({ scale, cx: view.cx + (before.x - after.x), cy: view.cy + (before.y - after.y) })
  }

  /** Pointer position in document mm. */
  const atMm = (e: React.MouseEvent): Pt => {
    const rect = wrapRef.current!.getBoundingClientRect()
    return screenToWorld(view, rect.width, rect.height, { x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  // Build the live preview for whichever tool is dragging.
  const shapeFor = (from: Pt, to: Pt, shift: boolean): { paths: Pt[][]; closed: boolean } | null => {
    if (tool === 'rect') return { paths: [rectPath(from, to, shift)], closed: true }
    if (tool === 'ellipse') return { paths: [ellipsePath(from, to, shift)], closed: true }
    return null
  }

  const onDown = (e: React.MouseEvent) => {
    // Middle button always pans, whatever tool is active — otherwise picking a
    // shape tool would strand the user with no way to move around.
    if (e.button === 1) {
      panning.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy }
      return
    }
    if (tool === 'select') {
      if (e.button !== 0) return
      const p = atMm(e)
      // A handle on the CURRENT selection outranks whatever is under it: the
      // handle is small and deliberate, and the object beneath it is usually
      // the selected one anyway.
      if (selected) {
        const b = objectBox(selected)
        const h = b && hitHandle(b, p, HANDLE_PX / view.scale)
        if (b && h) {
          history.begin()
          xform.current = { kind: 'resize', handle: h, from: b, start: p, paths: selected.paths, id: selected.id }
          return
        }
      }
      const hit = pickObject(doc.objects, p, PICK_PX / view.scale)
      if (hit) {
        setSelectedId(hit.id)
        history.begin()
        xform.current = { kind: 'move', from: objectBox(hit)!, start: p, paths: hit.paths, id: hit.id }
        return
      }
      // Empty space: drop the selection and pan, which keeps the old
      // drag-anywhere-to-pan habit working.
      setSelectedId(null)
      panning.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy }
      return
    }
    if (e.button !== 0) return
    const p = atMm(e)
    if (tool === 'polygon') {
      polyPts.current = [...polyPts.current, p]
      setDraft({ paths: [polyPts.current], closed: false })
      return
    }
    dragging.current = { from: p, trail: [p] }
  }

  const onMove = (e: React.MouseEvent) => {
    const pan = panning.current
    if (pan) {
      setView((v) => ({ ...v, cx: pan.cx - (e.clientX - pan.x) / v.scale, cy: pan.cy - (e.clientY - pan.y) / v.scale }))
      return
    }
    const x = xform.current
    if (x) {
      const p = atMm(e)
      // Always recomputed from the ORIGINAL geometry, never from the previous
      // frame. Accumulating frame to frame drifts, and a resize that compounds
      // its own rounding walks away from the cursor.
      const next = x.kind === 'move'
        ? movePaths(x.paths, p.x - x.start.x, p.y - x.start.y)
        : fitPaths(x.paths, x.from, resizeBox(x.from, x.handle!, p, e.shiftKey))
      patch(x.id, (o) => ({ ...o, paths: next }))
      return
    }
    // Cursor feedback: a handle, a grabbable object, or nothing.
    if (tool === 'select' && !panning.current) {
      const p = atMm(e)
      const b = selected ? objectBox(selected) : null
      const h = b ? hitHandle(b, p, HANDLE_PX / view.scale) : null
      setHoverCursor(h ? handleCursor(h) : pickObject(doc.objects, p, PICK_PX / view.scale) ? 'move' : null)
    }
    if (tool === 'polygon' && polyPts.current.length) {
      // Rubber-band the next edge to the cursor.
      setDraft({ paths: [[...polyPts.current, atMm(e)]], closed: false })
      return
    }
    const d = dragging.current
    if (!d) return
    const p = atMm(e)
    if (tool === 'freehand') {
      d.trail.push(p)
      setDraft({ paths: [d.trail.slice()], closed: false })
      return
    }
    setDraft(shapeFor(d.from, p, e.shiftKey))
  }

  const onUp = (e: React.MouseEvent) => {
    panning.current = null
    if (xform.current) { xform.current = null; history.end(); return }
    const d = dragging.current
    if (!d) return
    dragging.current = null
    setDraft(null)
    const p = atMm(e)
    if (tool === 'freehand') {
      const fh = freehandPath(d.trail)
      // An open trail is a line: run stitch. A closed one is a region: fill.
      if (fh.path.length) addDrawn([fh.path], fh.closed, fh.closed ? 'Shape' : 'Line')
      return
    }
    if (!bigEnough(d.from, p)) return // a slipped click, not a shape
    const s = shapeFor(d.from, p, e.shiftKey)
    if (s) addDrawn(s.paths, true, tool === 'rect' ? 'Rectangle' : 'Ellipse')
  }

  const finishPolygon = useCallback(() => {
    const pts = polyPts.current
    polyPts.current = []
    setDraft(null)
    if (polygonUsable(pts)) addDrawn([pts], true, 'Polygon')
  }, [addDrawn])

  const cancelDraw = useCallback(() => {
    polyPts.current = []
    dragging.current = null
    setDraft(null)
  }, [])

  // Tool shortcuts, plus Enter/Esc for the polygon. Ignored while a text field
  // has focus, or typing a name would switch tools under the user.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)
      // Undo/redo are checked BEFORE the typing and modifier guards below:
      // they are the one shortcut that must work while a field has focus, and
      // they are the only ones that WANT a modifier.
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) history.redo(); else history.undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); history.redo(); return }
      if (typing) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape') {
        // Abandon a half-finished move or resize. history.cancel() restores
        // the pre-drag document AND drops the step it recorded, so a refused
        // drag leaves no trace in the stack at all.
        if (xform.current) { xform.current = null; history.cancel() }
        cancelDraw()
        return
      }
      if (e.key === 'Enter') { if (tool === 'polygon') finishPolygon(); return }
      const pick: Record<string, Tool> = { v: 'select', r: 'rect', e: 'ellipse', p: 'polygon', d: 'freehand' }
      const t = pick[e.key.toLowerCase()]
      if (t) { cancelDraw(); setTool(t) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool, finishPolygon, cancelDraw, history])

  const moveObject = (index: number, delta: number) =>
    setDoc((d) => {
      const objs = [...d.objects]
      const j = index + delta
      if (j < 0 || j >= objs.length) return d
      const tmp = objs[index]
      objs[index] = objs[j]
      objs[j] = tmp
      return { ...d, objects: objs }
    })

  // --- render -------------------------------------------------------------
  return (
    <div className="app">
      <div className="toolbar">
        <div className="group">
          <label>Artwork</label>
          <FilePick label="Import SVG…" accept=".svg,image/svg+xml" onPick={importSvg} />
          <FilePick label="Open DST…" accept=".dst,.DST" onPick={importDstReference} />
          {reference && <button onClick={() => setReference(null)}>Clear ref</button>}
        </div>

        <div className="group">
          <label>Project</label>
          <FilePick label="Open…" accept={`.${FILE_EXT},application/json`} onPick={openProject} />
          <button onClick={saveProject} disabled={!doc.objects.length}>Save</button>
        </div>

        <div className="group">
          <label>Edit</label>
          <button onClick={history.undo} disabled={!history.canUndo}
            title="Undo (Cmd/Ctrl+Z)">Undo</button>
          <button onClick={history.redo} disabled={!history.canRedo}
            title="Redo (Cmd/Ctrl+Shift+Z)">Redo</button>
        </div>

        <div className="group">
          <label>Export</label>
          <button className="primary" onClick={exportPackage} disabled={!total}>Export package</button>
          <button onClick={exportDstOnly} disabled={!total} title="Machine file only — no colours travel with a DST">
            .dst only
          </button>
        </div>

        <div className="group">
          <label>Draw</label>
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`tool${tool === t.id ? ' on' : ''}`}
              title={t.hint}
              onClick={() => { cancelDraw(); setTool(t.id) }}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        <div className="group">
          <label>Stitch</label>
          {TYPES.map((t) => (
            <button
              key={t.id}
              className={`tool${selected?.type === t.id ? ' on' : ''}`}
              title={t.hint}
              disabled={!selected}
              onClick={() => selected && patch(selected.id, (o) => ({ ...o, type: t.id }))}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        <div className="group">
          <label>Machine</label>
          <select
            value={doc.hoop.name} title={doc.hoop.note ?? ''}
            onChange={(e) => setDoc((d) => ({ ...d, hoop: HOOPS.find((h) => h.name === e.target.value) ?? d.hoop }))}
          >
            {[...new Set(HOOPS.map((h) => h.group))].map((g) => (
              <optgroup key={g} label={g}>
                {HOOPS.filter((h) => h.group === g).map((h) => (
                  <option key={h.name} value={h.name} disabled={!mountable.has(h.name)}>
                    {h.name} — {h.widthMm.toFixed(0)}×{h.heightMm.toFixed(0)} mm
                    {mountable.has(h.name) ? '' : ` (needs ${h.minSpacing})`}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <select
            value={doc.spacing} title="Bracket spacing — limits which hoops mount"
            onChange={(e) => setDoc((d) => ({ ...d, spacing: e.target.value as Spacing }))}
          >
            {SPACINGS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <input
            type="number" min={1} max={24} value={machine.needles} style={{ width: 54 }}
            title="Needles — more colour blocks than this means a mid-run re-thread"
            onChange={(e) => {
              const v = parseInt(e.target.value, 10)
              if (Number.isFinite(v)) setMachine((m) => ({ ...m, needles: Math.max(1, v) }))
            }}
          />
          <button onClick={fit}>Fit</button>
        </div>

        <div className="group">
          <label>View</label>
          {([
            ['showArt', 'Art'], ['showStitches', 'Stitches'], ['showJumps', 'Jumps'],
            ['showPoints', 'Points'], ['showGrid', 'Grid'],
          ] as const).map(([k, lbl]) => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <input type="checkbox" checked={opts[k]} onChange={(e) => setOpts((o) => ({ ...o, [k]: e.target.checked }))} />
              {lbl}
            </label>
          ))}
        </div>
      </div>

      <div className="body">
        <div className="side">
          <h3>Sewing sequence</h3>
          {!doc.objects.length && (
            <div className="empty">
              Import an SVG to begin. Each closed shape becomes an object you can assign a stitch type to.
            </div>
          )}
          {doc.objects.map((o, i) => (
            <div key={o.id} className={`obj${o.id === selectedId ? ' sel' : ''}`} onClick={() => setSelectedId(o.id)}>
              <span className="seq">{i + 1}</span>
              <span className="sw" style={{ background: o.color }} />
              <span className="nm">{o.name}</span>
              <span className="ty">{o.type}</span>
              <button className="eye" title="Sew earlier" disabled={i === 0}
                onClick={(e) => { e.stopPropagation(); moveObject(i, -1) }}>↑</button>
              <button className="eye" title="Sew later" disabled={i === doc.objects.length - 1}
                onClick={(e) => { e.stopPropagation(); moveObject(i, 1) }}>↓</button>
              <button className="eye" title={o.visible ? 'Hide' : 'Show'}
                onClick={(e) => { e.stopPropagation(); patch(o.id, (x) => ({ ...x, visible: !x.visible })) }}>
                {o.visible ? '●' : '○'}
              </button>
            </div>
          ))}
          {doc.objects.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
              <button onClick={() => { setDoc((d) => ({ ...d, objects: [] })); setSelectedId(null) }}>Clear all</button>
              {selected && (
                <button onClick={() => {
                  setDoc((d) => ({ ...d, objects: d.objects.filter((o) => o.id !== selected.id) }))
                  setSelectedId(null)
                }}>Delete</button>
              )}
            </div>
          )}
        </div>

        <div
          className="canvas-wrap" ref={wrapRef}
          onWheel={onWheel} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp}
          onMouseLeave={onUp} onDoubleClick={() => tool === 'polygon' && finishPolygon()}
          onContextMenu={(e) => { if (tool !== 'select') { e.preventDefault(); cancelDraw() } }}
        >
          <canvas
            ref={canvasRef}
            className={tool === 'select' ? undefined : 'drawing'}
            style={tool === 'select' && hoverCursor ? { cursor: hoverCursor } : undefined}
          />
        </div>

        <div className="side right">
          <h3>Properties</h3>
          {!selected && <div className="empty">Select an object to set its stitch type and parameters.</div>}
          {selected && (
            <>
              <Text label="Name" value={selected.name}
                onChange={(v) => patch(selected.id, (o) => ({ ...o, name: v }), 'name')} />
              <div className="row">
                <label>Screen colour</label>
                <input type="color" value={selected.color}
                  onChange={(e) => patch(selected.id, (o) => ({ ...o, color: e.target.value }), 'color')} />
              </div>

              <fieldset>
                <legend>Thread</legend>
                <Text label="Brand" placeholder="Isacord" value={selected.thread.brand ?? ''}
                  onChange={(v) => patch(selected.id, (o) => ({ ...o, thread: { ...o.thread, brand: v || undefined } }), 'thread.brand')} />
                <Text label="Code" placeholder="spool no." value={selected.thread.code ?? ''}
                  onChange={(v) => patch(selected.id, (o) => ({ ...o, thread: { ...o.thread, code: v || undefined } }), 'thread.code')} />
                <Text label="Name" placeholder="optional" value={selected.thread.name ?? ''}
                  onChange={(v) => patch(selected.id, (o) => ({ ...o, thread: { ...o.thread, name: v || undefined } }), 'thread.name')} />
              </fieldset>

              {(selected.type === 'run' || selected.type === 'bean') && (
                <fieldset>
                  <legend>{selected.type === 'bean' ? 'Bean' : 'Run'}</legend>
                  <Num label="Stitch length (mm)" value={selected.run.length} min={0.5} max={12}
                    onChange={(v) => patch(selected.id, (o) => ({ ...o, run: { ...o.run, length: v } }), 'run.length')} />
                </fieldset>
              )}

              {selected.type === 'satin' && (
                <fieldset>
                  <legend>Satin</legend>
                  <Num label="Width (mm)" value={selected.satin.width} min={0.4} max={12}
                    onChange={(v) => patch(selected.id, (o) => ({ ...o, satin: { ...o.satin, width: v } }), 'satin.width')} />
                  <Num label="Stitch spacing (mm)" value={selected.satin.density} step={0.05} min={0.15} max={2}
                    onChange={(v) => patch(selected.id, (o) => ({ ...o, satin: { ...o.satin, density: v } }), 'satin.density')} />
                  <Num label="Pull compensation (mm)" value={selected.satin.pullComp} step={0.05} min={0} max={1}
                    onChange={(v) => patch(selected.id, (o) => ({ ...o, satin: { ...o.satin, pullComp: v } }), 'satin.pullComp')} />
                  <div className="row">
                    <label>Underlay</label>
                    <select value={selected.satin.underlay}
                      onChange={(e) => patch(selected.id, (o) => ({ ...o, satin: { ...o.satin, underlay: e.target.value as never } }))}>
                      <option value="none">None</option>
                      <option value="center">Centre run</option>
                      <option value="edge">Edge runs</option>
                      <option value="zigzag">Zigzag</option>
                    </select>
                  </div>
                </fieldset>
              )}

              {selected.type === 'fill' && (
                <>
                  <fieldset>
                    <legend>Tatami fill</legend>
                    <Num label="Angle (°)" value={selected.fill.angle} step={5} min={-180} max={180}
                      onChange={(v) => patch(selected.id, (o) => ({ ...o, fill: { ...o.fill, angle: v } }), 'fill.angle')} />
                    <Num label="Stitch spacing (mm)" value={selected.fill.spacing} step={0.05} min={0.15} max={2}
                      onChange={(v) => patch(selected.id, (o) => ({ ...o, fill: { ...o.fill, spacing: v } }), 'fill.spacing')} />
                    <Num label="Stitch length (mm)" value={selected.fill.length} step={0.25} min={1} max={10}
                      onChange={(v) => patch(selected.id, (o) => ({ ...o, fill: { ...o.fill, length: v } }), 'fill.length')} />
                    <Num label="Stagger (0–1)" value={selected.fill.stagger} step={0.05} min={0} max={1}
                      onChange={(v) => patch(selected.id, (o) => ({ ...o, fill: { ...o.fill, stagger: v } }), 'fill.stagger')} />
                    <Num label="Pull compensation (mm)" value={selected.fill.pullComp} step={0.05} min={0} max={1}
                      onChange={(v) => patch(selected.id, (o) => ({ ...o, fill: { ...o.fill, pullComp: v } }), 'fill.pullComp')} />
                    <div className="row">
                      <label>Underlay</label>
                      <select value={selected.fill.underlay}
                        onChange={(e) => patch(selected.id, (o) => ({ ...o, fill: { ...o.fill, underlay: e.target.value as never } }))}>
                        <option value="none">None</option>
                        <option value="edge">Edge run</option>
                        <option value="zigzag">Zigzag</option>
                        <option value="double">Edge + zigzag</option>
                      </select>
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend>Satin border</legend>
                    <div className="row">
                      <label>Add border</label>
                      <input type="checkbox" checked={selected.fill.border.enabled}
                        onChange={(e) => patch(selected.id, (o) => ({ ...o, fill: { ...o.fill, border: { ...o.fill.border, enabled: e.target.checked } } }))} />
                    </div>
                    {selected.fill.border.enabled && (
                      <>
                        <Num label="Width (mm)" value={selected.fill.border.width} min={0.4} max={10}
                          onChange={(v) => patch(selected.id, (o) => ({ ...o, fill: { ...o.fill, border: { ...o.fill.border, width: v } } }), 'fill.border.width')} />
                        <Num label="Stitch spacing (mm)" value={selected.fill.border.density} step={0.05} min={0.15} max={2}
                          onChange={(v) => patch(selected.id, (o) => ({ ...o, fill: { ...o.fill, border: { ...o.fill.border, density: v } } }), 'fill.border.density')} />
                      </>
                    )}
                  </fieldset>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <div className="status">
        {busy && <span className="busy">generating…</span>}
        <span><b>{counts.stitches.toLocaleString()}</b> stitches</span>
        <span><b>{counts.jumps}</b> jumps</span>
        <span><b>{stats.trims}</b> trims</span>
        <span><b>{counts.colors}</b> colour{counts.colors === 1 ? '' : 's'}</span>
        {pb && (
          <span>
            <b>{pb.widthMm.toFixed(1)} × {pb.heightMm.toFixed(1)}</b> mm
            {' '}({(pb.widthMm / 25.4).toFixed(2)} × {(pb.heightMm / 25.4).toFixed(2)} in)
          </span>
        )}
        {total > 0 && <span>longest <b>{longestStitch(plan).toFixed(1)}</b> mm</span>}
        {total > 0 && <span>~<b>{stats.minutes.toFixed(1)}</b> min</span>}
        {ms > 0 && <span className="dim">{ms.toFixed(0)} ms{inline ? ' inline' : ''}</span>}
        {note && <span className="note">{note}</span>}
        {stats.warnings.map((w, i) => <span key={i} className="warn">⚠ {w}</span>)}
        <span className="sim">
          <label>Stitch-out</label>
          <input
            type="range" min={0} max={total} value={sim ?? total}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10)
              setSim(v >= total ? null : v)
            }}
            disabled={!total}
          />
          <span>{(sim ?? total).toLocaleString()}/{total.toLocaleString()}</span>
        </span>
      </div>
    </div>
  )
}
