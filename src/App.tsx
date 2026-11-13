import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { centerPlan } from './digitize'
import { readDst, writeDst } from './dst'
import { close, toRegions } from './geometry'
import { useHistory } from './history'
import { DEFAULT_TOLERANCE, traceRegionAt, type Raster } from './trace'
import { DEFAULT_TEXT, SUGGESTED_FACES, textToOutlines, type TextSpec } from './text'
import {
  arcThrough, autoSmooth, deleteNode, flattenShape, handlesOf, insertNode, moveHandle, moveNode,
  nearestSegment, pathToShape, shapesToPaths, toggleSmooth, type PathNode, type Shape,
} from './nodes'
import { bigEnough, ellipsePath, freehandPath, polygonUsable, rectPath } from './draw'
import {
  boxCentre, fitPaths, handleCursor, hitHandle, movePaths, objectBox, pickObject,
  resizeBox, rotatePaths, rotationAngle, unionBox, type Box, type Handle,
} from './transform'
import {
  HOOPS,
  SPACINGS,
  bounds,
  emptyDoc,
  hoopsForSpacing,
  newObject,
  FILL_UNDERLAY_ORDER,
  SATIN_UNDERLAY_ORDER,
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
/** How far above the selection the rotation grip sits, screen px. */
const ROTATE_PX = 26

/** Where in-progress work is parked so a reload does not lose it. */
const AUTOSAVE_KEY = 'gleembroidery.autosave.v1'

/** Canvas tools. 'select' picks/moves/resizes; empty space still pans. */
type Tool = 'select' | 'node' | 'rect' | 'ellipse' | 'polygon' | 'freehand' | 'pen' | 'arc' | 'column' | 'wand' | 'text'

const TOOLS: { id: Tool; label: string; hint: string; icon: ReactElement }[] = [
  {
    id: 'select', label: 'Select', hint: 'Click an object to select it, drag to move, drag a handle to resize. Shift keeps the proportions. Drag empty space to pan. (V)',
    icon: (
      <svg width="22" height="16" viewBox="0 0 22 16"><path d="M8 2l6 6-2.5.7L13 12l-1.8.8-1.5-3.3L8 11.5z" fill="currentColor" /></svg>
    ),
  },
  {
    id: 'node', label: 'Nodes', hint: 'Reshape an outline: drag nodes and handles, double-click a segment to add a node, Delete removes one, Alt-click toggles corner/smooth (N)',
    icon: (
      <svg width="22" height="16" viewBox="0 0 22 16">
        <path d="M3 12c5 0 5-8 10-8s5 8 6 8" stroke="currentColor" strokeWidth="1.3" fill="none" />
        <rect x="1" y="10" width="4" height="4" fill="currentColor" />
        <rect x="11" y="2" width="4" height="4" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'pen', label: 'Pen', hint: 'Click for a corner, Cmd-click for a curve, or drag to pull a handle. Click the first node to close, Enter finishes open (B)',
    icon: (
      <svg width="22" height="16" viewBox="0 0 22 16">
        <path d="M2 13l4-9 5 7 3-4 6 6" stroke="currentColor" strokeWidth="1.3" fill="none" />
        <circle cx="6" cy="4" r="1.8" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'arc', label: 'Arc', hint: 'Click the start, then the end, then the bulge (A)',
    icon: (
      <svg width="22" height="16" viewBox="0 0 22 16">
        <path d="M3 13a8 8 0 0116 0" stroke="currentColor" strokeWidth="1.4" fill="none" />
        <circle cx="11" cy="5" r="1.7" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'column', label: 'Column', hint: 'Satin column: click alternate sides — each pair of clicks is one rung. Cmd-click for a curved edge, drag for a handle, Enter to finish (C)',
    icon: (
      <svg width="22" height="16" viewBox="0 0 22 16">
        <path d="M2 4c6-3 12 3 18 0" stroke="currentColor" strokeWidth="1.3" fill="none" />
        <path d="M2 12c6-3 12 3 18 0" stroke="currentColor" strokeWidth="1.3" fill="none" />
        <path d="M4 3.4v9.2M9 4.6v9.2M14 5.6v9.2M19 3.9v9.2" stroke="currentColor" strokeWidth="0.7" opacity="0.8" />
      </svg>
    ),
  },
  {
    id: 'wand', label: 'Wand', hint: 'Click a colour in the backdrop image to trace it into a shape (W)',
    icon: (
      <svg width="22" height="16" viewBox="0 0 22 16">
        <path d="M3 14L13 4" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <path d="M15 2l.7 1.8L17.5 4.5l-1.8.7L15 7l-.7-1.8L12.5 4.5l1.8-.7z" fill="currentColor" />
        <path d="M19 8l.5 1.2 1.2.5-1.2.5L19 11.5l-.5-1.3-1.2-.5 1.2-.5z" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'text', label: 'Text', hint: 'Click to set a line of lettering; edit the words, face and size in Properties (T)',
    icon: (
      <svg width="22" height="16" viewBox="0 0 22 16">
        <path d="M3 3.5h16M11 3.5V13" stroke="currentColor" strokeWidth="1.7" fill="none" />
        <path d="M8 13h6" stroke="currentColor" strokeWidth="1.3" fill="none" />
      </svg>
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

/**
 * Underlay layer picker.
 *
 * Checkboxes, not a dropdown: underlay is layered in practice — a centre run
 * to place, an edge run to support the rails, a zigzag to lift the nap — and
 * a digitizer picks the combination the fabric needs. They sew in a fixed
 * craft order whatever order they are ticked, so the order is stated here
 * rather than left for the user to wonder about.
 */
function UnderlayPicker<T extends string>({ value, options, order, onChange }: {
  value: readonly T[]
  options: { id: T; label: string }[]
  order: readonly T[]
  onChange: (next: T[]) => void
}) {
  const on = (id: T) => value.includes(id)
  return (
    <div className="row wide">
      <label>Underlay {value.length > 1 && <span className="dim">· sewn in order</span>}</label>
      <div className="checks">
        {options.map((o) => (
          <label key={o.id} className="check">
            <input
              type="checkbox" checked={on(o.id)}
              onChange={(e) => {
                const want = e.target.checked
                  ? [...value, o.id]
                  : value.filter((k) => k !== o.id)
                onChange(order.filter((k) => want.includes(k)) as T[])
              }} />
            {o.label}
          </label>
        ))}
        {value.length === 0 && <span className="dim">none</span>}
      </div>
    </div>
  )
}

export default function App() {
  // The document lives behind an undo stack. `setDoc` records a step;
  // history.begin()/end() collapse a drag into one; a `tag` coalesces rapid
  // edits to the same field. See history.ts.
  const history = useHistory<Doc>(emptyDoc)
  const doc = history.state
  const setDoc = history.set
  // A LIST, because move/resize/rotate all act on a whole selection. The
  // first entry is the "primary" one the Properties panel edits — every
  // existing single-selection read still works through `selectedId` below.
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const selectedId = selectedIds[0] ?? null
  const setSelectedId = useCallback((id: string | null) => setSelectedIds(id ? [id] : []), [])
  const [view, setView] = useState<View>({ scale: 3, cx: 0, cy: 0 })
  const [reference, setReference] = useState<StitchPlan | null>(null)
  const [sim, setSim] = useState<number | null>(null)
  const [machine, setMachine] = useState<MachineProfile>(DEFAULT_MACHINE)
  const [note, setNote] = useState<string | null>(null)
  const [opts, setOpts] = useState<Omit<RenderOptions, 'upTo' | 'selectedId' | 'reference' | 'draft' | 'selectionBox' | 'nodeEdit' | 'rotateOffsetPx' | 'marquee' | 'backdrop'>>({
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
  // Pen: nodes placed so far, plus the node being dragged out right now (a
  // press places it, a drag pulls its handles, release commits it).
  const penNodes = useRef<PathNode[]>([])
  const penDrag = useRef<PathNode | null>(null)
  // Arc: the clicks banked so far — start, then end; the third point bulges it.
  const arcPts = useRef<Pt[]>([])
  // Two-rail satin, built by clicking ALTERNATE SIDES: every pair of clicks
  // is one rung of the ladder. That is how a digitizer works, and it also
  // makes the pairing explicit — the engine joins the points that were
  // clicked together rather than inferring a correspondence from arc length.
  const colA = useRef<PathNode[]>([])
  const colB = useRef<PathNode[]>([])
  // Node editing: which node is active (for Delete), and what is being dragged.
  const [activeNode, setActiveNode] = useState<{ s: number; i: number } | null>(null)
  const nodeDrag = useRef<{ s: number; i: number; which: 'node' | 'hIn' | 'hOut' } | null>(null)
  // A move or resize in flight. Holds the object's ORIGINAL geometry so every
  // frame recomputes from it — and so Escape can put it back, which is the
  // only safety net here until there is an undo stack.
  const xform = useRef<
    {
      kind: 'move' | 'resize' | 'rotate'
      handle?: Handle
      from: Box
      start: Pt
      /** Original geometry of EVERY selected object, by id. */
      items: { id: string; paths: Pt[][] }[]
    } | null
  >(null)
  const [hoverCursor, setHoverCursor] = useState<string | null>(null)
  /**
   * Space is held: left-drag pans whatever tool is active.
   *
   * With a drawing tool selected, left-drag draws, so the only way to move
   * the view was the middle button — which a trackpad does not have. Holding
   * space to pan is the convention in every design tool for exactly this
   * reason, and it works the same in all of them.
   */
  const [spacePan, setSpacePan] = useState(false)
  /**
   * Cmd (or Ctrl) is held: the pointer behaves as the Select arrow whatever
   * tool is active — the convention in every drawing app, and what lets you
   * nudge something without putting the tool down.
   *
   * EXCEPT while a path is actually being drawn, where Cmd was already
   * established as "place a curve node". That is not a clash in practice:
   * mid-path there is nothing to select, and interrupting a half-drawn
   * outline to pick a different object would lose it.
   */
  const [cmdHeld, setCmdHeld] = useState(false)
  /**
   * Reference image behind the design, and the pixels the wand reads.
   *
   * The ImageData is kept beside the bitmap because tracing needs raw bytes
   * and pulling them back off a canvas on every click would re-decode the
   * image each time.
   */
  const [backdrop, setBackdrop] = useState<
    { bitmap: HTMLImageElement; raster: Raster; pxPerMm: number; origin: Pt; name: string } | null
  >(null)
  const [wandTolerance, setWandTolerance] = useState(DEFAULT_TOLERANCE)
  // Shift-drag rubber band over empty space, for selecting several at once.
  const marquee = useRef<Pt | null>(null)
  const [marqueeBox, setMarquee] = useState<{ a: Pt; b: Pt } | null>(null)

  // Generation runs in a worker, keyed to the document revision, so a slow
  // result can never land on top of a newer edit.
  const { plan, warnings, busy, ms, inline } = useStitchPlan(doc)
  const counts = useMemo(() => countStitches(plan), [plan])
  const pb = useMemo(() => planBounds(plan), [plan])
  const total = counts.stitches + counts.jumps
  const stats = useMemo(() => packageStats(doc, plan, warnings, machine), [doc, plan, warnings, machine])

  const selected = doc.objects.find((o) => o.id === selectedId) ?? null
  const selectedObjs = useMemo(
    () => doc.objects.filter((o) => selectedIds.includes(o.id)), [doc.objects, selectedIds])
  /** Box around everything selected — what the handles and pivot hang off. */
  const selBox = useMemo(
    () => unionBox(selectedObjs.map(objectBox)), [selectedObjs])

  // Hoops whose arms fit this machine's bracket. Non-mountable sizes stay
  // visible but disabled, so the operator learns the constraint instead of
  // wondering why a hoop they own is missing from the list.
  const mountable = useMemo(
    () => new Set(hoopsForSpacing(doc.spacing).map((h) => h.name)),
    [doc.spacing],
  )

  /**
   * The editable outlines of an object, adopting its polylines the first time
   * it is node-edited. Shapes drawn before this feature existed, and anything
   * imported from SVG, only have `paths` — refusing to edit those would make
   * the tool useless on exactly the artwork people most want to fix.
   */
  const shapesOf = useCallback((o: EmbObject): Shape[] =>
    o.shapes?.length ? o.shapes : o.paths.map((p) => pathToShape(p)), [])

  /** Replace an object's outlines and re-derive the polylines it is sewn from. */
  const setShapes = useCallback((id: string, shapes: Shape[], tag?: string) => {
    patch(id, (o) => ({ ...o, shapes, paths: shapesToPaths(shapes) }), tag)
  }, [])

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
      selectionBox: tool === 'select' ? selBox : null,
      rotateOffsetPx: tool === 'select' && selBox ? ROTATE_PX : undefined,
      marquee: marqueeBox,
      backdrop: backdrop && {
        bitmap: backdrop.bitmap, origin: backdrop.origin,
        widthMm: backdrop.raster.width / backdrop.pxPerMm,
        heightMm: backdrop.raster.height / backdrop.pxPerMm,
      },
      nodeEdit: tool === 'node' && selected ? { shapes: shapesOf(selected), active: activeNode } : null,
    })
  }, [doc, plan, view, opts, sim, selectedId, reference, draft, tool, selected, shapesOf, activeNode, selBox, marqueeBox, backdrop])

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

  /**
   * Add an object from editable nodes. The flattened polyline is derived here
   * and kept in `paths` so the stitch engine never has to know about curves.
   */
  const addShape = useCallback((shape: Shape, label: string) => {
    const n = doc.objects.length
    const paths = shapesToPaths([shape])
    if (!paths[0] || paths[0].length < 2) return
    const obj = newObject({
      name: `${label} ${n + 1}`,
      color: PALETTE[n % PALETTE.length],
      type: shape.closed ? 'fill' : 'run',
      paths,
      shapes: [shape],
    })
    setDoc((d) => ({ ...d, objects: [...d.objects, obj] }))
    setSelectedId(obj.id)
    setSim(null)
  }, [doc.objects.length, setDoc])

  /** Finish the pen path currently being drawn. */
  const finishPen = useCallback((closed: boolean) => {
    const nodes = penNodes.current
    penNodes.current = []
    penDrag.current = null
    setDraft(null)
    if (nodes.length >= 2) addShape({ nodes: autoSmooth(nodes, closed), closed }, closed ? 'Shape' : 'Path')
  }, [addShape])

  /**
   * Finish the two-rail column being clicked out.
   *
   * Needs at least two complete rungs; a single rung is a line across a gap,
   * not a column. Any trailing half-rung is dropped rather than guessed at.
   */
  const finishColumn = useCallback(() => {
    const n = Math.min(colA.current.length, colB.current.length)
    const a = autoSmooth(colA.current.slice(0, n))
    const b = autoSmooth(colB.current.slice(0, n))
    colA.current = []
    colB.current = []
    penDrag.current = null
    setDraft(null)
    if (n < 2) { setNote('A column needs at least two rungs — click both sides again'); return }
    const pair: Shape[] = [{ nodes: a, closed: false }, { nodes: b, closed: false }]
    const i = doc.objects.length
    const obj = newObject({
      name: `Column ${i + 1}`,
      color: PALETTE[i % PALETTE.length],
      type: 'satin',
      twoRail: true,
      paths: shapesToPaths(pair),
      shapes: pair,
    })
    setDoc((d) => ({ ...d, objects: [...d.objects, obj] }))
    setSelectedId(obj.id)
    setSim(null)
    setNote(`Column with ${n} rungs`)
  }, [doc.objects.length, setDoc, setSelectedId])

  /**
   * Load a reference image to trace over.
   *
   * Sized so its WIDTH matches the hoop by default: a logo arrives with no
   * physical size, and the hoop is the only real dimension in the document,
   * so it is the one sensible guess. The operator scales it afterwards.
   */
  const importImage = async (file: File) => {
    try {
      const url = URL.createObjectURL(file)
      const bitmap = await new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image()
        im.onload = () => resolve(im)
        im.onerror = () => reject(new Error('could not decode that image'))
        im.src = url
      })
      const cv = document.createElement('canvas')
      cv.width = bitmap.naturalWidth
      cv.height = bitmap.naturalHeight
      const ctx = cv.getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('could not read the image')
      ctx.drawImage(bitmap, 0, 0)
      const id = ctx.getImageData(0, 0, cv.width, cv.height)
      const pxPerMm = cv.width / doc.hoop.widthMm
      const origin = { x: -doc.hoop.widthMm / 2, y: -(cv.height / pxPerMm) / 2 }
      setBackdrop({ bitmap, raster: { data: id.data, width: cv.width, height: cv.height }, pxPerMm, origin, name: file.name })
      setTool('wand')
      setNote(`${file.name} loaded — click a colour with the Wand to trace it`)
    } catch (e) {
      alert(`Could not load that image: ${(e as Error).message}`)
    }
  }

  /**
   * Regenerate an object's outlines from its text spec.
   *
   * Lettering is re-rasterised on every edit rather than transformed, so a
   * face change or a longer word comes out as that face and that word, not
   * as the old shapes stretched to fit.
   */
  const applyText = useCallback((id: string, spec: TextSpec, at?: Pt) => {
    const out = textToOutlines(spec)
    for (const w of out.warnings) setNote(w)
    if (!out.paths.length) return
    const paths = at ? out.paths.map((r) => r.map((q) => ({ x: q.x + at.x, y: q.y + at.y }))) : null
    patch(id, (o) => {
      // Keep the lettering where it already sits: re-rasterising recentres on
      // the origin, so without this every edit would teleport it.
      const b = paths ? null : bounds(o.paths)
      const c = b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : { x: 0, y: 0 }
      return {
        ...o,
        text: spec,
        shapes: undefined,
        // Follow the words in the sewing sequence, but only while the name
        // has not been set by hand — renaming over someone's own label would
        // lose it the next time they fixed a typo.
        name: o.name === o.text?.content ? spec.content || o.name : o.name,
        paths: paths ?? out.paths.map((r) => r.map((q) => ({ x: q.x + c.x, y: q.y + c.y }))),
      }
    }, 'text')
  }, [])

  /** Place a new line of lettering. */
  const addText = useCallback((at: Pt) => {
    const spec = DEFAULT_TEXT()
    const out = textToOutlines(spec)
    for (const w of out.warnings) setNote(w)
    if (!out.paths.length) return
    const n = doc.objects.length
    const obj = newObject({
      name: spec.content,
      color: PALETTE[n % PALETTE.length],
      type: 'fill',
      text: spec,
      paths: out.paths.map((r) => r.map((q) => ({ x: q.x + at.x, y: q.y + at.y }))),
    })
    setDoc((d) => ({ ...d, objects: [...d.objects, obj] }))
    setSelectedId(obj.id)
    setSim(null)
    setNote(`${out.widthMm.toFixed(1)} × ${out.heightMm.toFixed(1)} mm — edit the words in Properties`)
  }, [doc.objects.length, setDoc, setSelectedId])

  /** Trace whatever colour was clicked into a new object. */
  const wandAt = useCallback((p: Pt) => {
    if (!backdrop) { setNote('Load a reference image first — Artwork ▸ Image'); return }
    const px = (p.x - backdrop.origin.x) * backdrop.pxPerMm
    const py = (p.y - backdrop.origin.y) * backdrop.pxPerMm
    const res = traceRegionAt(backdrop.raster, px, py, {
      tolerance: wandTolerance,
      pxPerMm: backdrop.pxPerMm,
      originMm: backdrop.origin,
      simplifyMm: 0.2,
    })
    for (const w of res.warnings) setNote(w)
    if (!res.paths.length) return
    const n = doc.objects.length
    const obj = newObject({
      name: `Traced ${n + 1}`,
      color: PALETTE[n % PALETTE.length],
      type: 'fill',
      paths: res.paths.map((ring) => [...ring, { ...ring[0] }]),
    })
    setDoc((d) => ({ ...d, objects: [...d.objects, obj] }))
    setSelectedId(obj.id)
    setSim(null)
    if (!res.warnings.length) setNote(`Traced ${res.paths.length} contour(s) from ${backdrop.name}`)
  }, [backdrop, wandTolerance, doc.objects.length, setDoc, setSelectedId])

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

  /** Is an outline half-drawn right now? */
  const drawing = () =>
    penNodes.current.length > 0 || polyPts.current.length > 0
    || colA.current.length > 0 || colB.current.length > 0

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
    // Space-drag, the middle button, and the Wand (which never drags) all pan
    // whatever tool is active — otherwise picking a tool strands the view.
    if (e.button === 1 || spacePan || tool === 'wand') {
      panning.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy }
      return
    }
    if (tool === 'node') {
      if (e.button !== 0) return
      const p = atMm(e)
      const tol = HANDLE_PX / view.scale
      if (selected) {
        const shapes = shapesOf(selected)
        // Handles are tested first: they sit off the outline and are the
        // smaller target, so whatever is under them is rarely what was meant.
        for (let si = 0; si < shapes.length; si++) {
          for (const h of handlesOf(shapes[si])) {
            if (Math.hypot(p.x - h.at.x, p.y - h.at.y) <= tol) {
              history.begin()
              nodeDrag.current = { s: si, i: h.i, which: h.which }
              setActiveNode({ s: si, i: h.i })
              return
            }
          }
        }
        for (let si = 0; si < shapes.length; si++) {
          const ns = shapes[si].nodes
          for (let i = 0; i < ns.length; i++) {
            if (Math.hypot(p.x - ns[i].x, p.y - ns[i].y) <= tol) {
              setActiveNode({ s: si, i })
              // Alt-click flips corner <-> smooth without starting a drag.
              if (e.altKey) {
                const next = [...shapes]
                next[si] = toggleSmooth(shapes[si], i)
                setShapes(selected.id, next)
                return
              }
              history.begin()
              nodeDrag.current = { s: si, i, which: 'node' }
              return
            }
          }
        }
      }
      // Nothing of the current outline was hit — pick whatever is under it.
      const hit = pickObject(doc.objects, p, PICK_PX / view.scale)
      setSelectedId(hit?.id ?? null)
      setActiveNode(null)
      if (!hit) panning.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy }
      return
    }
    if (tool === 'select' || (cmdHeld && !drawing())) {
      if (e.button !== 0) return
      const p = atMm(e)
      const snapshot = () => selectedObjs.map((o) => ({ id: o.id, paths: o.paths }))
      if (selBox) {
        // The rotation grip sits off the top edge, clear of the resize
        // handles so the two can never be confused at any zoom.
        const pivot = boxCentre(selBox)
        const grip = { x: pivot.x, y: selBox.minY - ROTATE_PX / view.scale }
        if (Math.hypot(p.x - grip.x, p.y - grip.y) <= HANDLE_PX / view.scale) {
          history.begin()
          xform.current = { kind: 'rotate', from: selBox, start: p, items: snapshot() }
          return
        }
        const h = hitHandle(selBox, p, HANDLE_PX / view.scale)
        if (h) {
          history.begin()
          xform.current = { kind: 'resize', handle: h, from: selBox, start: p, items: snapshot() }
          return
        }
      }
      const hit = pickObject(doc.objects, p, PICK_PX / view.scale)
      if (hit) {
        // Shift toggles membership; a plain click replaces the selection,
        // unless the object is already in it — dragging a multi-selection by
        // one of its members must move all of them, not reset to that one.
        let ids: string[]
        if (e.shiftKey) {
          ids = selectedIds.includes(hit.id)
            ? selectedIds.filter((x) => x !== hit.id)
            : [...selectedIds, hit.id]
        } else {
          ids = selectedIds.includes(hit.id) ? selectedIds : [hit.id]
        }
        setSelectedIds(ids)
        if (ids.length) {
          history.begin()
          const objs = doc.objects.filter((o) => ids.includes(o.id))
          xform.current = {
            kind: 'move',
            from: unionBox(objs.map(objectBox))!,
            start: p,
            items: objs.map((o) => ({ id: o.id, paths: o.paths })),
          }
        }
        return
      }
      // Empty space. Shift keeps the selection and starts a marquee; a plain
      // drag still pans, which is the habit this tool was born with.
      if (e.shiftKey) { marquee.current = p; setMarquee({ a: p, b: p }); return }
      setSelectedIds([])
      panning.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy }
      return
    }
    if (e.button !== 0) return
    const p = atMm(e)
    if (tool === 'text') { addText(p); return }
    if (tool === 'pen' || tool === 'column') {
      // Clicking the first node closes the path — the standard way to finish a
      // region, and the only one that does not need a separate control.
      // A rail is an open edge; only the pen closes a path on its first node.
      if (tool === 'pen' && penNodes.current.length >= 2) {
        const first = penNodes.current[0]
        if (Math.hypot(p.x - first.x, p.y - first.y) <= PICK_PX / view.scale) {
          finishPen(true)
          return
        }
      }
      // Pressed, not yet released: a release here is a corner, a drag pulls
      // handles out of it into a curve. Holding Cmd/Ctrl marks it smooth, so
      // a curve can be clicked out point by point with no dragging at all —
      // the handles are fitted to its neighbours once they exist.
      penDrag.current = { x: p.x, y: p.y, ...(e.metaKey || e.ctrlKey ? { smooth: true } : {}) }
      return
    }
    if (tool === 'arc') {
      arcPts.current = [...arcPts.current, p]
      if (arcPts.current.length === 3) {
        const [a, b, bulge] = arcPts.current
        arcPts.current = []
        setDraft(null)
        addShape(arcThrough(a, bulge, b), 'Arc')
      }
      return
    }
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
    if (marquee.current) {
      setMarquee({ a: marquee.current, b: atMm(e) })
      return
    }
    const x = xform.current
    if (x) {
      const p = atMm(e)
      // Always recomputed from the ORIGINAL geometry, never from the previous
      // frame. Accumulating frame to frame drifts, and a resize that compounds
      // its own rounding walks away from the cursor.
      const to = x.kind === 'resize' ? resizeBox(x.from, x.handle!, p, e.shiftKey) : null
      const rad = x.kind === 'rotate'
        ? rotationAngle(boxCentre(x.from), x.start, p, e.shiftKey ? 15 : 0) : 0
      const pivot = boxCentre(x.from)
      setDoc((d) => ({
        ...d,
        objects: d.objects.map((o) => {
          const it = x.items.find((q) => q.id === o.id)
          if (!it) return o
          const paths = x.kind === 'move' ? movePaths(it.paths, p.x - x.start.x, p.y - x.start.y)
            : x.kind === 'rotate' ? rotatePaths(it.paths, pivot, rad)
            : fitPaths(it.paths, x.from, to!)
          // Shapes carry the editable outline; a transform that ignored them
          // would resurrect the pre-drag curve the next time it was flattened.
          const shapes = o.shapes?.map((sh) => ({
            ...sh,
            nodes: sh.nodes.map((n) => {
              const m = (q: Pt) => {
                const one = x.kind === 'move' ? movePaths([[q]], p.x - x.start.x, p.y - x.start.y)
                  : x.kind === 'rotate' ? rotatePaths([[q]], pivot, rad)
                  : fitPaths([[q]], x.from, to!)
                return one[0][0]
              }
              const at = m({ x: n.x, y: n.y })
              return {
                ...n, x: at.x, y: at.y,
                hIn: n.hIn && m(n.hIn), hOut: n.hOut && m(n.hOut),
              }
            }),
          }))
          return { ...o, paths, ...(shapes ? { shapes } : {}) }
        }),
      }))
      return
    }
    // Cursor feedback: a handle, a grabbable object, or nothing.
    if ((tool === 'select' || (cmdHeld && !drawing())) && !panning.current) {
      const p = atMm(e)
      const b = selBox
      const h = b ? hitHandle(b, p, HANDLE_PX / view.scale) : null
      setHoverCursor(h ? handleCursor(h) : pickObject(doc.objects, p, PICK_PX / view.scale) ? 'move' : null)
    }
    const nd = nodeDrag.current
    if (nd && selected) {
      const p = atMm(e)
      const shapes = [...shapesOf(selected)]
      shapes[nd.s] = nd.which === 'node'
        ? moveNode(shapes[nd.s], nd.i, p)
        : moveHandle(shapes[nd.s], nd.i, nd.which, p)
      setShapes(selected.id, shapes)
      return
    }
    if (tool === 'column') {
      const p = atMm(e)
      const d = penDrag.current
      if (d) {
        // Dragging off a placed point pulls its handles, same as the pen.
        d.hOut = { x: p.x, y: p.y }
        d.hIn = { x: 2 * d.x - p.x, y: 2 * d.y - p.y }
        d.smooth = true
      }
      const nextIsA = colA.current.length <= colB.current.length
      const a = autoSmooth([...colA.current, ...(d && nextIsA ? [d] : [])])
      const b = autoSmooth([...colB.current, ...(d && !nextIsA ? [d] : [])])
      const paths: Pt[][] = []
      if (a.length >= 2) paths.push(flattenShape({ nodes: a, closed: false }))
      if (b.length >= 2) paths.push(flattenShape({ nodes: b, closed: false }))
      // The rungs ARE the column; drawing them is what makes the pairing
      // visible while it is being clicked out.
      const rungs = Math.min(a.length, b.length)
      for (let i = 0; i < rungs; i++) paths.push([{ x: a[i].x, y: a[i].y }, { x: b[i].x, y: b[i].y }])
      // A lone first point still needs to show, or the first click looks lost.
      if (!paths.length && (a.length || b.length)) {
        const only = a[0] ?? b[0]
        paths.push([{ x: only.x, y: only.y }, { x: p.x, y: p.y }])
      }
      setDraft(paths.length ? { paths, closed: false } : null)
      return
    }
    if (tool === 'pen') {
      const p = atMm(e)
      const d = penDrag.current
      if (d) {
        // Dragging away from the node pulls a symmetric pair of handles, so
        // the curve leaves and enters the node along one line.
        d.hOut = { x: p.x, y: p.y }
        d.hIn = { x: 2 * d.x - p.x, y: 2 * d.y - p.y }
        d.smooth = true
      }
      const preview = [...penNodes.current, ...(d ? [d] : [])]
      // Show the committed path plus a provisional segment to the cursor.
      const live = autoSmooth(d ? preview : [...preview, { x: p.x, y: p.y } as PathNode])
      const paths = live.length >= 2 ? [flattenShape({ nodes: live, closed: false })] : []
      setDraft(paths.length ? { paths, closed: false } : null)
      return
    }
    if (tool === 'arc' && arcPts.current.length) {
      const p = atMm(e)
      const pts = arcPts.current
      setDraft(pts.length === 1
        // Two points so far is just the chord; nothing to bulge yet.
        ? { paths: [[pts[0], p]], closed: false }
        : { paths: [flattenShape(arcThrough(pts[0], p, pts[1]))], closed: false })
      return
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
    const panned = panning.current
    panning.current = null
    // The wand fires on release, and only when the pointer did not travel:
    // that way a drag pans the view and a click still traces.
    if (tool === 'wand' && e.button === 0 && panned) {
      const moved = Math.hypot(e.clientX - panned.x, e.clientY - panned.y)
      if (moved < 4 && !spacePan) wandAt(atMm(e))
      return
    }
    if (marquee.current) {
      const a = marquee.current
      const b = atMm(e)
      marquee.current = null
      setMarquee(null)
      const box: Box = {
        minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y),
        maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y),
      }
      // Enclosed, not merely touched: a band that grabbed anything it brushed
      // would make it impossible to select behind a large shape.
      const hits = doc.objects.filter((o) => {
        if (!o.visible) return false
        const ob = objectBox(o)
        return !!ob && ob.minX >= box.minX && ob.maxX <= box.maxX
          && ob.minY >= box.minY && ob.maxY <= box.maxY
      })
      setSelectedIds((prev) => [...new Set([...prev, ...hits.map((o) => o.id)])])
      return
    }
    if (xform.current) { xform.current = null; history.end(); return }
    if (nodeDrag.current) { nodeDrag.current = null; history.end(); return }
    if (tool === 'column') {
      const d = penDrag.current
      penDrag.current = null
      if (d) {
        if (colA.current.length <= colB.current.length) colA.current = [...colA.current, d]
        else colB.current = [...colB.current, d]
        const rungs = Math.min(colA.current.length, colB.current.length)
        setNote(colA.current.length === colB.current.length
          ? `${rungs} rung${rungs === 1 ? '' : 's'} — Enter to finish`
          : 'now click the other side')
      }
      return
    }
    if (tool === 'pen') {
      if (penDrag.current) { penNodes.current = [...penNodes.current, penDrag.current]; penDrag.current = null }
      return
    }
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
    penNodes.current = []
    penDrag.current = null
    arcPts.current = []
    if (colA.current.length || colB.current.length) {
      colA.current = []
      colB.current = []
      setNote(null)
    }
    dragging.current = null
    setDraft(null)
  }, [])

  useEffect(() => {
    const mod = (e: KeyboardEvent) => setCmdHeld(e.metaKey || e.ctrlKey)
    const down = (e: KeyboardEvent) => {
      mod(e)
      if (e.code !== 'Space') return
      const el = e.target as HTMLElement | null
      // Space is a legitimate keystroke in a text field, and it also scrolls
      // the page by default — neither should become a pan.
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return
      e.preventDefault()
      setSpacePan(true)
    }
    const up = (e: KeyboardEvent) => { mod(e); if (e.code === 'Space') setSpacePan(false) }
    // A window that loses focus never delivers the keyup, so the view would
    // stay stuck in pan mode until space was pressed and released again.
    const clear = () => { setSpacePan(false); setCmdHeld(false) }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clear)
    }
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
      if (e.key === 'Enter') {
        if (tool === 'polygon') finishPolygon()
        else if (tool === 'pen') finishPen(false)
        else if (tool === 'column') finishColumn()
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && tool === 'node' && selected && activeNode) {
        e.preventDefault()
        const shapes = [...shapesOf(selected)]
        const before = shapes[activeNode.s]
        const after = deleteNode(before, activeNode.i)
        // deleteNode refuses to leave a husk; if it declined, say nothing and
        // leave the outline alone rather than pretending something happened.
        if (after !== before) {
          shapes[activeNode.s] = after
          setShapes(selected.id, shapes)
          setActiveNode(null)
        }
        return
      }
      const pick: Record<string, Tool> = {
        v: 'select', n: 'node', b: 'pen', a: 'arc', c: 'column', w: 'wand', t: 'text',
        r: 'rect', e: 'ellipse', p: 'polygon', d: 'freehand',
      }
      const t = pick[e.key.toLowerCase()]
      if (t) { cancelDraw(); setTool(t) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool, finishPolygon, finishPen, finishColumn, cancelDraw, history, selected, activeNode, shapesOf, setShapes])

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
          <FilePick label="Image…" accept="image/png,image/jpeg,image/gif,image/webp" onPick={importImage} />
          {backdrop && <button onClick={() => { setBackdrop(null); setNote(null) }}>Clear image</button>}
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

        {tool === 'wand' && (
          <div className="group">
            <label>Wand</label>
            <label className="check" title="How far a colour may differ and still be included">
              Tolerance
              <input
                type="range" min={2} max={80} step={1}
                value={Math.round(wandTolerance * 100)}
                onChange={(e) => setWandTolerance(Number(e.target.value) / 100)} />
              <span className="dim">{Math.round(wandTolerance * 100)}%</span>
            </label>
          </div>
        )}

        <div className="group">
          <label title="Hold Space and drag to pan from any tool; the scroll wheel zooms">View</label>
          <button onClick={fit} title="Fit the design to the window">Fit</button>
          <span className="dim">Space+drag to pan</span>
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
              {/* This used to read "Import an SVG to begin", which was true
                  when importing was the only way in — and was the reason the
                  drawing tools looked like they did not exist. */}
              Draw with the tools above, import an SVG, or load a reference image and trace
              it with the Wand. Each closed shape becomes an object you can assign a stitch
              type to.
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
          onMouseLeave={onUp} onDoubleClick={(e) => {
            if (tool === 'polygon') { finishPolygon(); return }
            if (tool === 'pen') { finishPen(false); return }
            if (tool === 'column') { finishColumn(); return }
            if (tool !== 'node' || !selected) return
            // Add a node where the outline was double-clicked. The split is
            // exact, so the shape does not twitch when a point appears.
            const p = atMm(e)
            const shapes = shapesOf(selected)
            let best: { s: number; i: number; t: number; d: number } | null = null
            shapes.forEach((sh, si) => {
              const hit = nearestSegment(sh, p, PICK_PX * 2 / view.scale)
              if (hit && (!best || hit.dist < best.d)) best = { s: si, i: hit.i, t: hit.t, d: hit.dist }
            })
            if (!best) return
            const b = best as { s: number; i: number; t: number; d: number }
            const next = [...shapes]
            next[b.s] = insertNode(shapes[b.s], b.i, b.t)
            setShapes(selected.id, next)
            setActiveNode({ s: b.s, i: b.i + 1 })
          }}
          onContextMenu={(e) => { if (tool !== 'select') { e.preventDefault(); cancelDraw() } }}
        >
          <canvas
            ref={canvasRef}
            className={
              spacePan ? 'grabbable'
                // Cmd shows the arrow, so the borrowed tool is visible before
                // the click rather than only after it.
                : cmdHeld && !drawing() ? 'arrow'
                  : tool === 'wand' ? 'grabbable'
                    : tool === 'select' ? undefined : 'drawing'
            }
            style={!spacePan && (tool === 'select' || cmdHeld) && hoverCursor ? { cursor: hoverCursor } : undefined}
          />
        </div>

        <div className="side right">
          <h3>Properties</h3>
          {!selected && <div className="empty">Select an object to set its stitch type and parameters.</div>}
          {selected && (
            <>
              {/* The stitch type also lives in the toolbar, but that is a row
                  of small icons far from the panel people actually read. With
                  only the toolbar, "satin border" was visible in Properties
                  while SATIN STITCH itself looked like it did not exist. */}
              <div className="row">
                <label>Stitch type</label>
                <select value={selected.type}
                  onChange={(e) => patch(selected.id, (o) => ({ ...o, type: e.target.value as StitchType }))}>
                  <option value="run">Run — single line</option>
                  <option value="bean">Bean — triple-pass line</option>
                  <option value="satin">Satin — zigzag column</option>
                  <option value="fill">Fill — tatami area</option>
                  <option value="none">Off — stitches nothing</option>
                </select>
              </div>
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

              {/* Lettering stays editable: the words, face and size are the
                  object, and the outlines are regenerated from them. */}
              {selected.text && (
                <fieldset>
                  <legend>Lettering</legend>
                  <div className="row wide">
                    <label>Text</label>
                    <input
                      type="text" value={selected.text.content}
                      onChange={(e) => applyText(selected.id, { ...selected.text!, content: e.target.value })} />
                  </div>
                  <div className="row wide">
                    <label>Font</label>
                    <input
                      type="text" list="gw-faces" value={selected.text.family}
                      placeholder="any font on this Mac"
                      onChange={(e) => applyText(selected.id, { ...selected.text!, family: e.target.value })} />
                    <datalist id="gw-faces">
                      {SUGGESTED_FACES.map((f) => <option key={f} value={f} />)}
                    </datalist>
                  </div>
                  <Num label="Letter height (mm)" value={selected.text.sizeMm} step={0.5} min={3} max={200}
                    onChange={(v) => applyText(selected.id, { ...selected.text!, sizeMm: v })} />
                  <Num label="Letter spacing (mm)" value={selected.text.trackingMm} step={0.1} min={-5} max={20}
                    onChange={(v) => applyText(selected.id, { ...selected.text!, trackingMm: v })} />
                  <Num label="Word spacing (mm)" value={selected.text.wordSpacingMm} step={0.5} min={-5} max={40}
                    onChange={(v) => applyText(selected.id, { ...selected.text!, wordSpacingMm: v })} />
                  <Num label="Slant (°)" value={selected.text.slantDeg} step={1} min={-45} max={45}
                    onChange={(v) => applyText(selected.id, { ...selected.text!, slantDeg: v })} />
                  {/* Top and bottom bow independently: equal values arc the
                      whole line, opposite values fan or taper it. */}
                  <Num label="Curve top (mm)" value={selected.text.curveTopMm} step={0.5} min={-60} max={60}
                    onChange={(v) => applyText(selected.id, { ...selected.text!, curveTopMm: v })} />
                  <Num label="Curve bottom (mm)" value={selected.text.curveBottomMm} step={0.5} min={-60} max={60}
                    onChange={(v) => applyText(selected.id, { ...selected.text!, curveBottomMm: v })} />
                  <div className="row wide">
                    <label>Shape</label>
                    <div className="checks">
                      <button onClick={() => applyText(selected.id, { ...selected.text!, curveTopMm: 0, curveBottomMm: 0 })}>Flat</button>
                      <button onClick={() => applyText(selected.id, { ...selected.text!, curveTopMm: 10, curveBottomMm: 10 })}>Arc</button>
                      <button onClick={() => applyText(selected.id, { ...selected.text!, curveTopMm: 8, curveBottomMm: -8 })}>Fan</button>
                      <button onClick={() => applyText(selected.id, { ...selected.text!, curveTopMm: -8, curveBottomMm: 8 })}>Pinch</button>
                    </div>
                  </div>
                  <div className="row wide">
                    <label>Style</label>
                    <div className="checks">
                      <label className="check">
                        <input type="checkbox" checked={selected.text.bold}
                          onChange={(e) => applyText(selected.id, { ...selected.text!, bold: e.target.checked })} />
                        Bold
                      </label>
                      <label className="check">
                        <input type="checkbox" checked={selected.text.italic}
                          onChange={(e) => applyText(selected.id, { ...selected.text!, italic: e.target.checked })} />
                        Italic
                      </label>
                    </div>
                  </div>
                </fieldset>
              )}

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
                  <UnderlayPicker
                    value={selected.satin.underlay}
                    order={SATIN_UNDERLAY_ORDER}
                    options={[
                      { id: 'center', label: 'Centre run' },
                      { id: 'edge', label: 'Edge runs' },
                      { id: 'zigzag', label: 'Zigzag' },
                    ]}
                    onChange={(next) => patch(selected.id, (o) => ({ ...o, satin: { ...o.satin, underlay: next } }))} />
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
                    <UnderlayPicker
                      value={selected.fill.underlay}
                      order={FILL_UNDERLAY_ORDER}
                      options={[
                        { id: 'edge', label: 'Edge run' },
                        { id: 'zigzag', label: 'Zigzag' },
                      ]}
                      onChange={(next) => patch(selected.id, (o) => ({ ...o, fill: { ...o.fill, underlay: next } }))} />
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
