import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Menu, MenuItem, MenuLabel, MenuSep, closeAllMenus } from './Menu'
import { Thumb } from './Thumb'
import { formatField, formatLength, parseLength, sizePair, type Unit } from './units'
import {
  RACK_KEY, nearestMachineThread, nearestSpools, newSpool, parseRack, serializeRack,
  spoolLabel, type Spool,
} from './threads'
import { colourName, reorder, runBlocks, threadChanges } from './runview'
import { classifyProblems, nextStep, summarise, type Problem } from './problems'
import { centerPlan } from './digitize'
import { readDst, writeDst } from './dst'
import { MAX_SATIN_MM, MAX_SPLIT_SATIN_MM } from './satin'
import {
  BUILT_IN_PRESETS, PRESETS_KEY, applyStyle, parsePresets, presetFrom,
  serializePresets, type StylePreset,
} from './presets'
import {
  ALPHABETS_KEY, alphabetCoverage, normaliseGlyph, parseAlphabets, serializeAlphabets,
  setAlphabetText, type Alphabet,
} from './alphabets'
import { writeExp } from './exp'
import { writeJef } from './jef'
import { FILL_STYLE_DEFAULTS, MIN_MOTIF_MM, MOTIFS } from './decorative'
import {
  BOOL_LABEL, BOOL_OPS, booleanOp, cleanNodes, joinShapes, offsetOp, removeOverlap,
  simplifyPaths, splitShapeAt,
} from './shapeops'
import {
  DUPLICATE_OFFSET_MM, alignDeltas, boxCentreOf, distributeDeltas, mirrorPt,
  type AlignEdge,
} from './arrange'
import { edgeVelocity, panStep } from './autoscroll'
import type { BoolOp } from './boolean'
import { close, segDist, toRegions } from './geometry'
import { initHistory, useHistory, type HistoryState } from './history'
import { CELL_MM, analyseDensity } from './density'
import {
  deleteStitches, freeze, freezeState, moveStitches, pickStitch, pickStitchesIn,
  type StitchRef,
} from './stitchedit'
import { DEFAULT_TOLERANCE, traceRegionAt, type Raster } from './trace'
import {
  DEFAULT_TEXT, SUGGESTED_FACES, textToColumns, textToOutlines,
  type LetterNudge, type LetterOutline, type TextSpec,
} from './text'
import {
  arcThrough, autoSmooth, deleteNode, flattenShape, handlesOf, insertNode, moveHandle, moveNode,
  nearestSegment, pathToShape, shapesToPaths, toggleSmooth, type PathNode, type Shape,
} from './nodes'
import { bigEnough, ellipsePath, freehandPath, polygonUsable, rectPath } from './draw'
import {
  MIN_SIZE_MM, boxCentre, fitPaths, handleCursor, hitHandle, movePaths, objectBox, pickObject,
  resizeBox, rotatePaths, rotationAngle, unionBox, type Box, type Handle,
} from './transform'
import {
  HOOPS,
  SPACINGS,
  bounds,
  objectVisible,
  emptyDoc,
  hoopsForSpacing,
  newObject,
  FILL_STYLES,
  FILL_STYLE_LABEL,
  FILL_UNDERLAY_ORDER,
  SATIN_UNDERLAY_ORDER,
  type Doc,
  type EmbObject,
  type Pt,
  type TieParams,
  type Backdrop,
  type FillStyle,
  type Group,
  type Spacing,
  type StitchType,
} from './model'
import {
  DEFAULT_MACHINE,
  packageStats,
  appliqueCutSvg,
  placementTemplateSvg,
  runSheetHtml,
  writeCol,
  writeEdr,
  type MachineProfile,
} from './package'
import { FILE_EXT, ProjectError, deserialize, docSignature, projectFilename, serialize } from './project'
import { fitView, render, screenToWorld, type RenderOptions, type View } from './render'
import { countStitches, longestStitch, planBounds, type StitchPlan } from './stitches'
import { useStitchPlan } from './useStitchPlan'
import { parseSvgToPaths } from './vector'

// Thread colours for freshly imported shapes — spaced around the wheel so
// adjacent objects are told apart at a glance before the user sets real ones.
/** Where the auto-scroll preference lives between sessions. */
const AUTOSCROLL_KEY = 'gleembroidery.autoscroll.v1'

/**
 * The part of a mouse event the canvas reads.
 *
 * A plain object rather than a MouseEvent so the auto-scroll loop can replay
 * the last pointer position while the view slides beneath a cursor that has
 * not moved.
 */
interface MoveLike { clientX: number; clientY: number; shiftKey: boolean }

const PALETTE = ['#c0392b', '#1f6feb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#1f2d3d']

/**
 * The garment colours worth one click.
 *
 * Deliberately the shirt colours a shop actually stocks and quotes in, not a
 * spectrum: the question being answered is "does this logo work on the blanks
 * we sell", and anything else is reachable through the colour picker beside
 * them.
 */
const GARMENTS: { name: string; color: string }[] = [
  { name: 'White', color: '#ffffff' },
  { name: 'Natural', color: '#efe6d2' },
  { name: 'Ash', color: '#d5d6d2' },
  { name: 'Sport grey', color: '#b1b3b3' },
  { name: 'Charcoal', color: '#53565a' },
  { name: 'Black', color: '#101113' },
  { name: 'Navy', color: '#1d2744' },
  { name: 'Royal', color: '#15489c' },
  { name: 'Carolina blue', color: '#7ba4db' },
  { name: 'Red', color: '#b3202c' },
  { name: 'Maroon', color: '#6b2032' },
  { name: 'Orange', color: '#dd6b20' },
  { name: 'Gold', color: '#e6bb2b' },
  { name: 'Irish green', color: '#00834a' },
  { name: 'Forest', color: '#213b2b' },
  { name: 'Purple', color: '#4b2a7b' },
  { name: 'Light pink', color: '#f2c2cf' },
  { name: 'Sand', color: '#cbb89a' },
]

/** Grab radius for a resize handle and for picking an object, screen px.
 *  Screen-constant on purpose: a tolerance in mm would be unusably tiny when
 *  zoomed out and absurdly fat when zoomed in. */
const HANDLE_PX = 6
const PICK_PX = 4
/**
 * Pick radius for individual stitches, screen px.
 *
 * Larger than PICK_PX because a stitch is the smallest target in the program
 * — a single point, often one of thousands a fraction of a millimetre apart.
 * At the object radius a click two pixels off a 0.4 mm thread simply misses.
 */
const STITCH_PICK_PX = 7
/** How far above the selection the rotation grip sits, screen px. */
const ROTATE_PX = 26

/** Where in-progress work is parked so a reload does not lose it. */
const AUTOSAVE_KEY = 'gleembroidery.autosave.v1'

/**
 * A design that is open but not on screen.
 *
 * `state` is null for the ACTIVE one: its stack lives in the history hook,
 * and keeping a second copy here would be two truths about one document.
 */
interface ParkedDoc {
  id: string
  state: HistoryState<Doc> | null
}

/** Canvas tools. 'select' picks/moves/resizes; empty space still pans. */
type Tool = 'select' | 'node' | 'rect' | 'ellipse' | 'polygon' | 'freehand' | 'pen' | 'arc' | 'column' | 'angle' | 'wand' | 'text' | 'stitch'

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
    id: 'angle', label: 'Angle', hint: 'Drag a line ACROSS a satin column to set which way its bars run. Guides interpolate between each other; click one to remove it (G)',
    icon: (
      <svg width="22" height="16" viewBox="0 0 22 16">
        <path d="M1 4h20M1 12h20" stroke="currentColor" strokeWidth="1.1" opacity="0.55" fill="none" />
        <path d="M4 13.2L9 2.8M12 13.2L17 2.8" stroke="currentColor" strokeWidth="1.5" fill="none" />
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
    id: 'text', label: 'Text', hint: 'Click to set a line of lettering; edit the words, face and size in the Object tab (T)',
    icon: (
      <svg width="22" height="16" viewBox="0 0 22 16">
        <path d="M3 3.5h16M11 3.5V13" stroke="currentColor" strokeWidth="1.7" fill="none" />
        <path d="M8 13h6" stroke="currentColor" strokeWidth="1.3" fill="none" />
      </svg>
    ),
  },
  {
    id: 'stitch', label: 'Stitches', hint: 'Edit individual stitches. The first edit FREEZES the plan — see the banner (S)',
    icon: (
      <svg width="22" height="16" viewBox="0 0 22 16">
        <path d="M2 11l5-6 4 6 4-6 5 6" stroke="currentColor" strokeWidth="1.2" fill="none" />
        <circle cx="7" cy="5" r="1.8" fill="currentColor" />
        <circle cx="15" cy="5" r="1.8" fill="currentColor" />
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

/**
 * What each stitch type is CALLED in the tree.
 *
 * Short, lower case, and the word a digitizer uses out loud — the tree is
 * read as a list of nouns ("column, column, fill"), not as an enum dump.
 */
const TYPE_WORD: Record<StitchType, string> = {
  run: 'run',
  bean: 'bean',
  satin: 'column',
  fill: 'fill',
  applique: 'appliqué',
  knockdown: 'knockdown',
  none: 'off',
}

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

const UNIT_KEY = 'gleembroidery.unit.v1'

/** Decode a data URL into an image, or reject with something readable. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image()
    im.onload = () => resolve(im)
    im.onerror = () => reject(new Error('could not decode that image'))
    im.src = src
  })
}

/**
 * A length field for the transform bar.
 *
 * Commits on Enter or on leaving the field, NOT on every keystroke: typing
 * "3 1/2" passes through "3", "3 ", "3 1", "3 1/" on the way, and a field
 * that applied each of those would resize the design four times and leave it
 * at whatever the last readable fragment was.
 *
 * Unreadable text is left alone and the field snaps back to the real value.
 * Refusing is the point — a field that turned nonsense into 0 would resize a
 * design to nothing, and the undo would be the only way back.
 */
function XField({ value, unit, onCommit, title, signed }: {
  value: number | null
  unit: Unit
  onCommit: (mm: number) => void
  title?: string
  /** Negatives are meaningful here (a position), not a mistake (a size). */
  signed?: boolean
}) {
  const [text, setText] = useState('')
  const [editing, setEditing] = useState(false)
  // What is still waiting to be applied. Held in a ref and CLEARED on the
  // way through, because Enter commits and then blurs — and the blur
  // handler fired a second commit with the same text, resizing the design
  // twice. Asking for 3 1/2" got 4 3/8".
  const pending = useRef<string | null>(null)
  const shown = editing ? text : (value === null ? '' : formatField(value, unit))

  const commit = () => {
    setEditing(false)
    const t = pending.current
    pending.current = null
    if (t === null) return
    const mm = parseLength(t, unit)
    if (mm === null) return
    if (!signed && mm <= 0) return
    onCommit(mm)
  }

  return (
    <input
      type="text" className="xf" title={title} value={shown} disabled={value === null}
      onFocus={(e) => {
        setEditing(true)
        setText(e.target.value)
        pending.current = null
        e.target.select()
      }}
      onChange={(e) => { setText(e.target.value); pending.current = e.target.value }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur() }
        if (e.key === 'Escape') {
          pending.current = null
          setEditing(false)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

/** A percentage that applies once and returns to 100. */
function ScaleField({ onCommit }: { onCommit: (pct: number) => void }) {
  const [text, setText] = useState('100')
  const commit = () => {
    const v = Number(text)
    setText('100')
    if (isFinite(v) && v > 0 && v !== 100) onCommit(v)
  }
  return (
    <input
      type="text" className="xf" value={text}
      title="Scale by this much, then back to 100 — because the new size IS the size"
      onFocus={(e) => e.target.select()}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur() }
        if (e.key === 'Escape') { setText('100'); (e.target as HTMLInputElement).blur() }
      }}
    />
  )
}

function Text({ label, value, placeholder, onChange, tag }: {
  label: string
  value: string
  placeholder?: string
  onChange: (v: string) => void
  /** A handle for something elsewhere to focus this field. */
  tag?: string
}) {
  return (
    <div className="row">
      <label>{label}</label>
      <input
        type="text" value={value} placeholder={placeholder} data-thread={tag}
        onChange={(e) => onChange(e.target.value)} />
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
  /**
   * Saved stitch styles.
   *
   * Read once on mount. A corrupt or missing store degrades to "no saved
   * presets" — the built-ins always work — rather than to an exception on
   * startup, which would take the whole application down over a stale key.
   */
  const [userPresets, setUserPresets] = useState<StylePreset[]>(() => {
    try { return parsePresets(window.localStorage.getItem(PRESETS_KEY)) } catch { return [] }
  })
  /** Saved embroidery alphabets. Read once, same rules as the presets. */
  const [alphabets, setAlphabets] = useState<Alphabet[]>(() => {
    try { return parseAlphabets(window.localStorage.getItem(ALPHABETS_KEY)) } catch { return [] }
  })
  const [activeAlphabet, setActiveAlphabet] = useState<string | null>(null)
  const [glyphChar, setGlyphChar] = useState('')
  const [newAlphabetName, setNewAlphabetName] = useState('My alphabet')
  const [alphabetWord, setAlphabetWord] = useState('ABC')
  const [alphabetSize, setAlphabetSize] = useState(20)
  const selectedId = selectedIds[0] ?? null
  const setSelectedId = useCallback((id: string | null) => setSelectedIds(id ? [id] : []), [])
  const [view, setView] = useState<View>({ scale: 3, cx: 0, cy: 0 })
  const [reference, setReference] = useState<StitchPlan | null>(null)
  const [sim, setSim] = useState<number | null>(null)
  const [machine, setMachine] = useState<MachineProfile>(DEFAULT_MACHINE)
  const [note, setNote] = useState<string | null>(null)
  const [opts, setOpts] = useState<Omit<RenderOptions, 'upTo' | 'selectedId' | 'reference' | 'draft' | 'selectionBox' | 'nodeEdit' | 'rotateOffsetPx' | 'marquee' | 'backdrop' | 'letterHandles' | 'endpoints' | 'density' | 'picked'>>({
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
  const [showDensity, setShowDensity] = useState(false)
  /** Stitches picked in the Stitches tool, as refs into the frozen plan. */
  const [picked, setPicked] = useState<StitchRef[]>([])
  const pickDrag = useRef<{ start: Pt; moved: boolean } | null>(null)
  /**
   * Letter boxes of the selected lettering, for its per-letter handles.
   *
   * Cached rather than recomputed per frame: working them out means
   * rasterising and tracing the whole line, which is far too much to do on
   * every mouse move.
   */
  const [letterBoxes, setLetterBoxes] = useState<{ id: string; letters: LetterOutline[] } | null>(null)
  const letterDrag = useRef<{ id: string; index: number; start: Pt; from: LetterNudge } | null>(null)
  const endDrag = useRef<{ id: string; which: 'entry' | 'exit' } | null>(null)
  // The angle guide being drawn. The ref drives the gesture; the state is
  // only so the canvas can show it while the mouse is still down.
  const guideDraw = useRef<{ id: string; a: Pt } | null>(null)
  const [guideDrag, setGuideDrag] = useState<{ a: Pt; b: Pt } | null>(null)
  /** Waiting for a click on the object whose outline lettering should follow. */
  const [pickingBaseline, setPickingBaseline] = useState(false)
  /**
   * Reference image behind the design, and the pixels the wand reads.
   *
   * The ImageData is kept beside the bitmap because tracing needs raw bytes
   * and pulling them back off a canvas on every click would re-decode the
   * image each time.
   */
  const [backdrop, setBackdrop] = useState<
    {
      bitmap: HTMLImageElement
      raster: Raster
      pxPerMm: number
      origin: Pt
      name: string
      /** It is stored in the project, so a document change can clear it. */
      fromDoc?: boolean
    } | null
  >(null)
  const [wandTolerance, setWandTolerance] = useState(DEFAULT_TOLERANCE)
  // Shift-drag rubber band over empty space, for selecting several at once.
  const marquee = useRef<Pt | null>(null)
  const [marqueeBox, setMarquee] = useState<{ a: Pt; b: Pt } | null>(null)

  // Generation runs in a worker, keyed to the document revision, so a slow
  // result can never land on top of a newer edit.
  const { plan, warnings, busy, ms, inline } = useStitchPlan(doc)
  const counts = useMemo(() => countStitches(plan), [plan])
  // Computed from the SAME plan that is exported, so what is flagged is what
  // the machine will sew — not a separate estimate that could disagree.
  const density = useMemo(() => analyseDensity(plan), [plan])
  // The signature the frozen plan is compared against — the same one the
  // generator keys on, so "the source changed" means exactly what it says.
  const sourceSig = useMemo(() => docSignature({ ...doc, frozen: undefined }), [doc])
  const frozenState = freezeState(doc.frozen, sourceSig)

  /**
   * Take the current plan under manual control.
   *
   * Called by the first stitch edit. Everything after it edits the frozen
   * copy, so generation never silently overwrites hand work.
   */
  const ensureFrozen = useCallback((): StitchPlan => {
    if (doc.frozen) return doc.frozen.plan
    const f = freeze(plan, sourceSig)
    setDoc((d) => ({ ...d, frozen: f }))
    setNote('Stitch plan frozen — source edits will ask before replacing your changes')
    return f.plan
  }, [doc.frozen, plan, sourceSig, setDoc])

  /** Apply a manual edit to the frozen plan. */
  const editStitches = useCallback((fn: (p: StitchPlan) => StitchPlan) => {
    const base = ensureFrozen()
    const next = fn(base)
    setDoc((d) => ({
      ...d,
      frozen: { plan: next, signature: d.frozen?.signature ?? sourceSig, edits: (d.frozen?.edits ?? 0) + 1 },
    }))
    setSim(null)
  }, [ensureFrozen, sourceSig, setDoc])
  const pb = useMemo(() => planBounds(plan), [plan])
  const total = counts.stitches + counts.jumps
  const stats = useMemo(() => packageStats(doc, plan, warnings, machine), [doc, plan, warnings, machine])
  /**
   * Everything wrong with the design, sorted and with its fixes attached.
   *
   * The density report is folded in here rather than kept beside it: an
   * over-dense patch is a problem with the design in exactly the way a
   * refused satin column is, and keeping two lists meant two places to look.
   */
  const problems = useMemo(
    () => classifyProblems([...stats.warnings, ...density.warnings], doc.objects),
    [stats.warnings, density.warnings, doc.objects])
  const summary = useMemo(() => summarise(problems), [problems])
  /** The single most serious thing with something to do about it. */
  const next = useMemo(() => nextStep(problems), [problems])
  const [showProblems, setShowProblems] = useState(false)

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
      ...opts, upTo: sim ?? undefined, selectedId, reference, draft, fabric: doc.fabric,
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
      letterHandles: tool === 'select' && selected?.text?.mode === 'fill' && letterBoxes?.id === selected.id
        ? letterBoxes.letters.map((l) => l.centre) : null,
      endpoints: tool === 'select' && selected && (selected.entry || selected.exit)
        ? { entry: selected.entry, exit: selected.exit } : null,
      density: showDensity ? { cells: density.hotspots, cellMm: CELL_MM } : null,
      picked: tool === 'stitch' ? picked : null,
      // Guides are shown while the Angle tool is active, and otherwise only
      // on the selected object: left on permanently they would clutter a
      // design that has dozens of them.
      guides: tool === 'angle' || selected?.guides?.length
        ? { lines: selected?.guides ?? [], draft: guideDrag }
        : null,
    })
  }, [doc, plan, view, opts, sim, selectedId, reference, draft, tool, selected, shapesOf, activeNode, selBox, marqueeBox, backdrop, letterBoxes, showDensity, density, picked, guideDrag])

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

  // --- open documents -------------------------------------------------------
  //
  // Several designs open at once, as in every digitizing package, because
  // the commonest real job is "make this one look like that one" — and
  // because copying an element between two files should not mean saving,
  // closing, opening and finding it again.
  //
  // The ACTIVE document lives in `history`, so everything else in this file
  // is unchanged. The others are parked as whole history stacks, undo and
  // all: switching tabs that threw away what you could take back would be
  // worse than not having tabs.

  const [parked, setParked] = useState<ParkedDoc[]>([])
  const [activeTab, setActiveTab] = useState(0)

  const switchTo = (index: number) => {
    if (index === activeTab) return
    const target = parked[index]
    if (!target) return
    const here = history.snapshot()
    setParked((ps) => ps.map((p, i) =>
      (i === activeTab ? { ...p, state: here } : i === index ? { ...p, state: null } : p)))
    history.install(target.state ?? initHistory(emptyDoc()))
    setActiveTab(index)
    setSelectedIds([])
    setPicked([])
    setSim(null)
    setTimeout(fit, 0)
  }

  const newDocument = () => {
    const here = history.snapshot()
    const fresh = emptyDoc()
    setParked((ps) => {
      const next = ps.map((p, i) => (i === activeTab ? { ...p, state: here } : p))
      next.push({ id: `d${Date.now().toString(36)}${next.length}`, state: null })
      setActiveTab(next.length - 1)
      return next
    })
    history.install(initHistory(fresh))
    setSelectedIds([])
    setPicked([])
    setSim(null)
    setNote('New design')
    setTimeout(fit, 0)
  }

  const closeDocument = (index: number) => {
    if (parked.length <= 1) { setNote('that is the only design open'); return }
    const closing = index === activeTab
      ? { ...parked[index], state: history.snapshot() }
      : parked[index]
    const name = closing.state?.present.name ?? doc.name
    const hasWork = (closing.state?.present.objects.length ?? 0) > 0
    if (hasWork && !window.confirm(
      `Close “${name}”?\n\nIt is only autosaved while it is open. Save it first if you want to keep it.`,
    )) return
    const next = parked.filter((_, i) => i !== index)
    const nextActive = activeTab > index ? activeTab - 1 : Math.min(activeTab, next.length - 1)
    setParked(next)
    if (closing === parked[activeTab] || index === activeTab) {
      history.install(next[nextActive]?.state ?? initHistory(emptyDoc()))
      setSelectedIds([])
      setTimeout(fit, 0)
    }
    setActiveTab(nextActive)
  }

  // --- autosave -----------------------------------------------------------
  // Explicit Save writes a file; this exists only so a refresh or a crash
  // does not lose work in progress. EVERY open document is saved, not just
  // the one on screen — a tab you cannot see is still unsaved work.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(AUTOSAVE_KEY)
      if (!saved) { setParked([{ id: 'd0', state: null }]); setTimeout(fit, 0); return }
      // Two shapes to read: the multi-document wrapper, and a single
      // serialized project from before tabs existed. An older autosave is
      // somebody's unsaved work and must still open.
      const first = saved.trimStart()[0]
      let docs: Doc[] = []
      if (first === '[') {
        const raw = JSON.parse(saved)
        docs = (Array.isArray(raw) ? raw : []).map((t: string) => deserialize(t))
      } else {
        docs = [deserialize(saved)]
      }
      const live = docs.filter((d) => d.objects.length)
      if (!live.length) { setParked([{ id: 'd0', state: null }]); setTimeout(fit, 0); return }
      history.install(initHistory(live[0]))
      setParked(live.map((d, i) => ({
        id: `d${i}`,
        state: i === 0 ? null : initHistory(d),
      })))
      setActiveTab(0)
      setSelectedId(live[0].objects[0]?.id ?? null)
      setNote(live.length > 1
        ? `Restored ${live.length} designs from your last session`
        : 'Restored unsaved work from your last session')
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
      setParked([{ id: 'd0', state: null }])
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
      const all = parked.map((p, i) => (i === activeTab ? doc : p.state?.present))
        .filter((d): d is Doc => !!d && d.objects.length > 0)
      if (!all.length) {
        try { localStorage.removeItem(AUTOSAVE_KEY) } catch { /* ignore */ }
        return
      }
      const write = (docs: Doc[]) =>
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(docs.map((d) => serialize(d))))
      try {
        write(all)
      } catch {
        // Out of quota, and the commonest reason by far is a reference
        // picture: an image is bigger than any design. Drop the PICTURES and
        // keep the designs, because the design is the work and the picture
        // is a tracing aid that can be loaded again.
        try {
          write(all.map((d) => ({ ...d, backdrop: undefined })))
          setNote('Autosaved without the reference image — it was too large. Use Save to keep it.')
        } catch {
          // Still too big. Clear the slot rather than leave a smaller, OLDER
          // autosave behind to be restored later as if it were current.
          try { localStorage.removeItem(AUTOSAVE_KEY) } catch { /* ignore */ }
          setNote('This design is too large to autosave — use Save to keep it.')
        }
      }
    }, 600)
    return () => clearTimeout(t)
  }, [doc, parked, activeTab])


  // --- document edits -----------------------------------------------------
  // `tag` groups rapid edits to the SAME field into one undo step — typing
  // "12.5" into a box is one action, not four.
  const patch = (id: string, fn: (o: EmbObject) => EmbObject, tag?: string) =>
    setDoc((d) => ({ ...d, objects: d.objects.map((o) => (o.id === id ? fn(o) : o)) }),
      tag && `${tag}:${id}`)

  // --- stitch-style presets ------------------------------------------------
  //
  // Kept in localStorage rather than in the document: the point of a preset
  // is that it outlives the project it was made in. A shop's cap-satin
  // settings are a property of the shop, not of one design.

  /**
   * Turn lettering into ordinary outlines.
   *
   * The spec asks for this to be EXPLICIT, and it is a one-way door: the
   * words, face and size stop existing, and what is left is the polygons
   * they produced. That is exactly what you want when a letterform has to be
   * reshaped by hand — a serif extended, a counter opened up — and it is
   * exactly what you do not want by accident, which is why nothing else in
   * the program does it silently.
   */
  const convertTextToOutlines = (id: string) => {
    const o = doc.objects.find((q) => q.id === id)
    if (!o?.text) return
    if (!window.confirm(
      'Convert this lettering to outlines?\n\n'
      + 'The words, font and size stop being editable. The shapes stay, and can be '
      + 'node-edited like any other outline.')) return
    patch(id, (q) => ({ ...q, text: undefined }))
    setLetterBoxes(null)
    setNote('Converted to outlines — the shapes are editable, the words are not')
  }

  // --- native embroidery alphabets -----------------------------------------
  //
  // A letter captured here is GEOMETRY, not stitches: it is set by whatever
  // settings the object carries, so one alphabet sews as a satin at 8 mm and
  // as a fill at 40 mm. Storing stitches would freeze the density, underlay
  // and pull compensation into the letterform, and an alphabet captured on
  // one fabric would be wrong on every other.

  const saveAlphabets = (next: Alphabet[]) => {
    setAlphabets(next)
    try { window.localStorage.setItem(ALPHABETS_KEY, serializeAlphabets(next)) } catch { /* private mode */ }
  }

  /**
   * Put the selected object's outline into an alphabet as one character.
   *
   * Inline rather than through a prompt: which characters an alphabet
   * already has is the thing you need to see while adding to it, and a
   * modal dialog is the one place that cannot show you.
   */
  const captureGlyph = (ch: string) => {
    const c = ch.trim()
    if (!selectedObjs.length || c.length !== 1) return
    const paths = selectedObjs.flatMap((o) => o.paths)
    const target = alphabets.find((a) => a.id === activeAlphabet) ?? alphabets[0] ?? {
      id: `al${Date.now().toString(36)}`,
      name: newAlphabetName.trim() || 'My alphabet',
      capHeightMm: 10,
      glyphs: {},
    }
    const g = normaliseGlyph(paths, target.capHeightMm)
    if (!g) { setNote('that outline has no height to normalise by'); return }
    const next: Alphabet = { ...target, glyphs: { ...target.glyphs, [c]: g } }
    saveAlphabets([next, ...alphabets.filter((a) => a.id !== next.id)])
    setActiveAlphabet(next.id)
    setGlyphChar('')
    setNote(`"${c}" added to ${next.name} — ${alphabetCoverage(next).length} character(s)`)
  }

  /** Set a word from an alphabet as a new object. */
  const setFromAlphabet = (a: Alphabet, text: string, sizeMm: number) => {
    if (!text) return
    const r = setAlphabetText(a, text, Math.max(1, sizeMm))
    if (!r.paths.length) {
      setNote(`"${a.name}" has none of those characters — it has ${alphabetCoverage(a).join('') || 'nothing'}`)
      return
    }
    addDrawn(r.paths.map((ring) => close(ring)), true, text)
    // A missing character is REPORTED, never substituted from a system font:
    // silently mixing a digitized A with a traced B gives a word whose
    // letters do not match, and that is only obvious once it is sewn.
    setNote(r.missing.length
      ? `set "${text}" — but ${a.name} has no ${r.missing.map((c) => `"${c}"`).join(', ')}, so there are gaps`
      : `set "${text}" from ${a.name}`)
  }

  // --- groups ---------------------------------------------------------------
  //
  // A group is a NAME, a visibility and a lock. It deliberately does not
  // touch the sewing order: the sequence is what the machine does, and a
  // group that dragged its members together to tidy a list would change
  // which colour goes down first.

  /** The ids of everything in the same groups as the current selection. */
  const expandToGroups = (ids: readonly string[]): string[] => {
    const gs = new Set(
      doc.objects.filter((o) => ids.includes(o.id) && o.group).map((o) => o.group!))
    if (!gs.size) return [...ids]
    return [...new Set([
      ...ids,
      ...doc.objects.filter((o) => o.group && gs.has(o.group)).map((o) => o.id),
    ])]
  }

  const groupSelection = () => {
    if (selectedObjs.length < 2) { setNote('select two or more objects to group'); return }
    const id = `g${Date.now().toString(36)}`
    const ids = selectedObjs.map((o) => o.id)
    setDoc((d) => ({
      ...d,
      groups: [...d.groups, { id, name: `Group ${d.groups.length + 1}` }],
      objects: d.objects.map((o) => (ids.includes(o.id) ? { ...o, group: id } : o)),
    }))
    setNote(`grouped ${ids.length} objects — the sewing order is unchanged`)
  }

  const ungroupSelection = () => {
    const gs = new Set(selectedObjs.map((o) => o.group).filter(Boolean) as string[])
    if (!gs.size) { setNote('nothing grouped in the selection'); return }
    setDoc((d) => ({
      ...d,
      // A group with no members left is removed: an empty row in the panel
      // is something to wonder about rather than something to use.
      groups: d.groups.filter((g) => !gs.has(g.id)),
      objects: d.objects.map((o) => (o.group && gs.has(o.group) ? { ...o, group: undefined } : o)),
    }))
    setNote(`ungrouped ${gs.size} group${gs.size === 1 ? '' : 's'}`)
  }

  const patchGroup = (id: string, f: (g: Group) => Group) =>
    setDoc((d) => ({ ...d, groups: d.groups.map((g) => (g.id === id ? f(g) : g)) }))

  /** Is this object out of reach — locked, or in a hidden group? */
  const unreachable = useCallback((o: EmbObject): boolean => {
    if (!o.group) return false
    const g = doc.groups.find((q) => q.id === o.group)
    return !!g && (!!g.locked || !!g.hidden)
  }, [doc.groups])

  /** Objects a click may land on: locked and hidden groups are not among them. */
  const pickable = useMemo(
    () => doc.objects.filter((o) => !unreachable(o)), [doc.objects, unreachable])

  // --- the run view ---------------------------------------------------------
  //
  // Blocks are DERIVED from the document on every render, never stored: the
  // document is still an ordered list of objects, and this is a reading of
  // it. Move an object and the blocks re-form.

  const blocks = useMemo(() => runBlocks(doc, plan), [doc, plan])
  /** The group the selection is in, when it is all in one. */
  const selGroup = useMemo(() => {
    const ids = new Set(selectedObjs.map((o) => o.group).filter(Boolean))
    return ids.size === 1 ? doc.groups.find((g) => g.id === [...ids][0]) ?? null : null
  }, [selectedObjs, doc.groups])
  const threads = useMemo(() => threadChanges(blocks), [blocks])
  /**
   * A block's identity for folding.
   *
   * Keyed on the FIRST object in it, because that is the thing that survives
   * a re-derive: the block's number changes when something above it is
   * hidden, and its index changes when anything is reordered.
   */
  const blockKey = (b: { objects: { object: EmbObject }[] }) => b.objects[0].object.id
  /** Which inspector tab is showing. */
  const [inspector, setInspector] = useState<'colour' | 'object' | 'design'>('object')
  /**
   * Which unit the numbers are written in.
   *
   * Remembered across sessions: a shop works in one or the other, and being
   * asked again every morning is its own small insult.
   */
  const [unit, setUnit] = useState<Unit>(() => {
    try { return window.localStorage.getItem(UNIT_KEY) === 'mm' ? 'mm' : 'inch' } catch { return 'inch' }
  })
  useEffect(() => {
    try { window.localStorage.setItem(UNIT_KEY, unit) } catch { /* private mode */ }
  }, [unit])
  const [lockAspect, setLockAspect] = useState(true)
  const [turnDeg, setTurnDeg] = useState(90)
  /**
   * The whole design's extent, so every thumbnail shares one frame.
   *
   * From the ARTWORK rather than the stitches: the tree has to be usable
   * while generation is still running, and an object with no stitches yet
   * still has an outline to show.
   */
  const designBounds = useMemo(
    () => bounds(doc.objects.flatMap((o) => o.paths)), [doc.objects])

  // Drag-to-reorder. Two buttons per row that each moved an object one place
  // meant twenty-five presses to bring the bottom object to the top.
  // Drag a row to change when it sews.
  //
  // Pointer events, not HTML5 drag-and-drop. HTML5 DnD does not fire for
  // synthetic events so none of it could be exercised in a test, it has no
  // touch story, and inside a scrolling panel its drop targets are famously
  // unreliable. Pointer capture has none of those problems.
  //
  // Named distinctly from the canvas's own `dragging` ref, which is a shape
  // being drawn out — a different gesture entirely.
  const [rowDrag, setRowDrag] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

  /**
   * Which gap the pointer is over, as an index into the object list.
   *
   * The gap ABOVE a row, or the end of the list when the pointer is past the
   * last one. Read from the DOM rather than from stored geometry because the
   * panel scrolls and folds while a drag is in flight.
   */
  const gapUnder = useCallback((clientY: number): number | null => {
    const rows = [...document.querySelectorAll<HTMLElement>('.side [data-row]')]
    if (!rows.length) return null
    for (const row of rows) {
      const b = row.getBoundingClientRect()
      if (clientY < b.top + b.height / 2) return Number(row.dataset.row)
    }
    return doc.objects.length
  }, [doc.objects.length])

  useEffect(() => {
    if (rowDrag === null) return
    const onMove = (e: PointerEvent) => setDragOver(gapUnder(e.clientY))
    const onUp = (e: PointerEvent) => {
      const to = gapUnder(e.clientY)
      setRowDrag(null)
      setDragOver(null)
      if (to !== null) setDoc((d) => ({ ...d, objects: reorder(d.objects, rowDrag, to) }))
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setRowDrag(null); setDragOver(null) }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey)
    }
  }, [rowDrag, gapUnder])

  // --- the thread rack ------------------------------------------------------
  //
  // There is no built-in Madeira or Isacord chart, and that is deliberate: a
  // thread code is only useful if it is RIGHT, and a catalogue reconstructed
  // half-accurately is worse than none because it looks authoritative. What
  // is built in is the Brother palette, which comes from the file format
  // itself and can be stated exactly. Everything else is a rack this shop
  // fills from its own cones — typed once, correct by construction.

  const [rack, setRack] = useState<Spool[]>(() => {
    try { return parseRack(window.localStorage.getItem(RACK_KEY)) } catch { return [] }
  })
  const saveRack = (next: Spool[]) => {
    setRack(next)
    try { window.localStorage.setItem(RACK_KEY, serializeRack(next)) } catch { /* private mode */ }
  }
  /** Which block's thread is being chosen, by its first object's id. */
  const [picking, setPicking] = useState<string | null>(null)
  const [newBrand, setNewBrand] = useState('Madeira Classic 40')
  const [newCode, setNewCode] = useState('')
  const [newName, setNewName] = useState('')

  /** Put a thread on every object in the same block. */
  const assignThread = (anchorId: string, thread: { brand?: string; code?: string; name?: string }) => {
    const block = blocks.find((b) => b.objects.some((q) => q.object.id === anchorId))
    const ids = block ? block.objects.map((q) => q.object.id) : [anchorId]
    setDoc((d) => ({
      ...d,
      objects: d.objects.map((o) => (ids.includes(o.id) ? { ...o, thread: { ...thread } } : o)),
    }))
    setPicking(null)
    setNote(`${spoolLabel(thread)} on ${ids.length} object${ids.length === 1 ? '' : 's'}`)
  }

  /** Select the object a problem is about, and bring it into view. */
  const showProblemObject = (p: Problem) => {
    if (!p.objectId) return
    setSelectedIds([p.objectId])
    setInspector('object')
    const o = doc.objects.find((q) => q.id === p.objectId)
    const b = o && objectBox(o)
    const wrap = wrapRef.current
    if (b && wrap) {
      // Centre it and zoom so it fills about half the canvas — enough to see
      // what is wrong with it, not so much that it loses its context.
      const w = Math.max(1, b.maxX - b.minX), h = Math.max(1, b.maxY - b.minY)
      const scale = Math.min(wrap.clientWidth / (w * 2), wrap.clientHeight / (h * 2))
      setView({
        scale: Math.max(0.2, Math.min(60, scale)),
        cx: (b.minX + b.maxX) / 2,
        cy: (b.minY + b.maxY) / 2,
      })
    }
    setShowProblems(false)
  }

  // --- the numeric transform ------------------------------------------------
  //
  // Dragging a handle is how you place something. TYPING is how you make it
  // exactly three inches wide, because that is what the customer asked for
  // and what the quote says.
  //
  // Every one of these goes through mapObjects, so paths, nodes, angle
  // guides and the entry/exit markers all move together. Anything that
  // transformed only `paths` would leave the editable outline behind and
  // resurrect the old shape on the next flatten.

  /**
   * Resize the selection, anchored at its CENTRE.
   *
   * The centre and not a corner, because the Centre fields beside this one
   * are the position: anchoring at a corner would make a resize move the
   * thing whose position you had just set, and the numbers would chase each
   * other round the bar.
   */
  const resizeSelection = (wMm: number | null, hMm: number | null) => {
    const from = selBox
    if (!from || !selectedObjs.length) return
    const w0 = Math.max(1e-6, from.maxX - from.minX)
    const h0 = Math.max(1e-6, from.maxY - from.minY)
    let w = wMm ?? w0
    let h = hMm ?? h0
    if (lockAspect) {
      if (wMm !== null) h = h0 * (w / w0)
      else if (hMm !== null) w = w0 * (h / h0)
    }
    w = Math.max(MIN_SIZE_MM, w)
    h = Math.max(MIN_SIZE_MM, h)
    const cx = (from.minX + from.maxX) / 2
    const cy = (from.minY + from.maxY) / 2
    const sx = w / w0, sy = h / h0
    mapObjects(selectedObjs.map((o) => o.id), () => (p) => ({
      x: cx + (p.x - cx) * sx,
      y: cy + (p.y - cy) * sy,
    }))
    setNote(`${formatLength(w, unit)} × ${formatLength(h, unit)}`)
  }

  /**
   * Scale by a factor.
   *
   * The field always reads 100% afterwards and that is not a bug: the new
   * size IS the size. A percentage that accumulated would have to remember
   * an original nobody kept, and would disagree with the width field the
   * moment either was edited.
   */
  const scaleSelection = (k: number) => {
    const from = selBox
    if (!from || !selectedObjs.length || !(k > 0) || k === 1) return
    const cx = (from.minX + from.maxX) / 2
    const cy = (from.minY + from.maxY) / 2
    mapObjects(selectedObjs.map((o) => o.id), () => (p) => ({
      x: cx + (p.x - cx) * k,
      y: cy + (p.y - cy) * k,
    }))
    setNote(`scaled to ${(k * 100).toFixed(0)}%`)
  }

  /**
   * Turn the selection by an angle.
   *
   * A TURN, not a setting, and the label says so. Rotation is applied to the
   * points themselves — an object does not carry an angle it could be set
   * to — so a field claiming to show "the rotation" would be inventing a
   * number the geometry does not have.
   */
  const turnSelection = (deg: number) => {
    const from = selBox
    if (!from || !selectedObjs.length || !deg) return
    const c = { x: (from.minX + from.maxX) / 2, y: (from.minY + from.maxY) / 2 }
    const rad = (deg * Math.PI) / 180
    const cos = Math.cos(rad), sin = Math.sin(rad)
    mapObjects(selectedObjs.map((o) => o.id), () => (p) => ({
      x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin,
      y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos,
    }))
    setNote(`turned ${deg}°`)
  }

  /** Put the selection's centre at a position, measured from the hoop's. */
  const moveSelectionTo = (x: number | null, y: number | null) => {
    const from = selBox
    if (!from || !selectedObjs.length) return
    const dx = x === null ? 0 : x - (from.minX + from.maxX) / 2
    const dy = y === null ? 0 : y - (from.minY + from.maxY) / 2
    if (!dx && !dy) return
    mapObjects(selectedObjs.map((o) => o.id), () => (p) => ({ x: p.x + dx, y: p.y + dy }))
  }

  /**
   * Delete the selected objects.
   *
   * Plural on purpose: a multi-selection deletes as one step, so undo takes
   * the whole lot back rather than restoring them one at a time.
   */
  const deleteSelection = () => {
    if (!selectedObjs.length) return
    const n = selectedObjs.length
    const ids = selectedObjs.map((o) => o.id)
    setDoc((d) => ({
      ...d,
      objects: d.objects.filter((o) => !ids.includes(o.id)),
      // A group with no members left is a row in the panel that nothing
      // belongs to, so it goes with them.
      groups: d.groups.filter((g) => d.objects.some((o) => o.group === g.id && !ids.includes(o.id))),
    }))
    setSelectedIds([])
    setNote(`${n} object${n === 1 ? '' : 's'} deleted — Cmd/Ctrl+Z puts ${n === 1 ? 'it' : 'them'} back`)
  }

  /**
   * Set the screen colour of several objects at once.
   *
   * Tagged so dragging through a colour picker is ONE undo step rather than
   * one per shade it passed through on the way.
   */
  const setColourOf = (ids: readonly string[], color: string) => {
    setDoc((d) => ({
      ...d,
      objects: d.objects.map((o) => (ids.includes(o.id) ? { ...o, color } : o)),
    }), `colour:${ids.join(',')}`)
  }

  // --- sew-out playback -----------------------------------------------------
  //
  // Watching it sew is how ordering mistakes show themselves: a colour that
  // runs twice, a travel across the middle of a finished area, a knockdown
  // laid after the thing it was meant to flatten. None of that is visible in
  // the finished picture, which is the point of a preview that moves.

  const [playing, setPlaying] = useState(false)
  /**
   * How fast, as a multiple of the machine's own speed.
   *
   * Real time is honest but useless to watch — a 14,000-stitch design at
   * 800 spm is eighteen minutes. Expressed as a multiple rather than as an
   * abstract "speed" so the number still means something: 1x is what the
   * machine does.
   */
  const [speed, setSpeed] = useState(20)
  const playPos = useRef(0)

  useEffect(() => {
    if (!playing || !total) return
    // Start again from the beginning if it is sitting at the end.
    playPos.current = sim === null || sim >= total ? 0 : sim
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000)
      last = now
      playPos.current += (machine.spm / 60) * speed * dt
      if (playPos.current >= total) {
        // Finish on the WHOLE design rather than one stitch short, and stop
        // — looping would make it impossible to see the last colour land.
        setSim(null)
        setPlaying(false)
        return
      }
      setSim(Math.floor(playPos.current))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // `sim` is deliberately not a dependency: it changes every frame, and
    // depending on it would tear the loop down and rebuild it sixty times a
    // second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, total, speed, machine.spm])

  const applyPreset = (p: StylePreset) => {
    if (!selectedObjs.length) { setNote('select an object first'); return }
    const ids = selectedObjs.map((o) => o.id)
    setDoc((d) => ({
      ...d,
      objects: d.objects.map((o) => (ids.includes(o.id) ? applyStyle(o, p) : o)),
    }))
    setNote(`"${p.name}" applied to ${ids.length} object${ids.length === 1 ? '' : 's'}`)
  }

  const savePreset = () => {
    if (!selected) return
    const name = window.prompt('Name this stitch style', `${selected.type} style`)
    if (!name?.trim()) return
    const next = [...userPresets, presetFrom(selected, name.trim())]
    setUserPresets(next)
    try { window.localStorage.setItem(PRESETS_KEY, serializePresets(next)) } catch { /* private mode */ }
    setNote(`Saved "${name.trim()}" — it will be there in your next project too`)
  }

  const deletePreset = (id: string) => {
    const next = userPresets.filter((p) => p.id !== id)
    setUserPresets(next)
    try { window.localStorage.setItem(PRESETS_KEY, serializePresets(next)) } catch { /* private mode */ }
  }

  /**
   * Change a document-level tie setting.
   *
   * Tagged for coalescing like any other continuous control, so dragging a
   * number field is one undo step and not twenty.
   */
  const setDocTie = (next: Partial<TieParams>) =>
    setDoc((d) => ({ ...d, tie: { ...d.tie, ...next } }), `tie:${Object.keys(next)[0]}`)

  // --- shape operations ----------------------------------------------------
  //
  // All of these are GEOMETRY edits: they produce ordinary objects the user
  // can go on editing, they never touch stitch parameters, and they never
  // generate stitches. Each one reports what it could not do rather than
  // quietly returning nothing, because "the button did nothing" is
  // indistinguishable from "the button is broken".

  /**
   * Replace the whole selection with one object carrying `paths`.
   *
   * The survivor is the BACK-most selected object — the one sewn first. It
   * keeps its name, colour, thread and every stitch parameter, so a boolean
   * does not silently reset a column anyone had set up. It also keeps its
   * position in the sewing sequence, which is what a digitizer expects: the
   * combined shape sews where the shape it was built on sewed.
   *
   * `shapes` are deliberately dropped. A boolean result is a NEW boundary
   * that no longer corresponds to the nodes either operand had; carrying the
   * old ones forward would mean the next flatten threw the result away.
   */
  const replaceSelection = (paths: Pt[][], verb: string) => {
    const ids = selectedObjs.map((o) => o.id)
    const keeper = selectedObjs[0]
    setDoc((d) => {
      const at = d.objects.findIndex((o) => o.id === keeper.id)
      const merged: EmbObject = {
        ...keeper, paths, shapes: undefined, guides: keeper.guides,
        name: `${keeper.name} (${verb})`,
      }
      const rest = d.objects.filter((o) => !ids.includes(o.id))
      rest.splice(Math.min(at, rest.length), 0, merged)
      return { ...d, objects: rest }
    })
    setSelectedIds([keeper.id])
  }

  const runBoolean = (op: BoolOp) => {
    const r = booleanOp(op, selectedObjs.map((o) => o.paths))
    if (r.errors.length) { setNote(r.errors[0]); return }
    replaceSelection(r.paths, BOOL_LABEL[op].toLowerCase())
    setNote(`${BOOL_LABEL[op]}d ${selectedObjs.length} objects`)
  }

  const runRemoveOverlap = () => {
    // Over the WHOLE design when nothing is selected, because double density
    // is a property of the design rather than of a selection — and the usual
    // reason to reach for this is a density warning about the whole thing.
    const targets = selectedObjs.length > 1 ? selectedObjs : doc.objects
    if (targets.length < 2) { setNote('needs at least two overlapping objects'); return }
    const ids = targets.map((o) => o.id)
    const out = removeOverlap(targets.map((o) => o.paths))
    const problem = out.find((r) => r.errors.length)
    if (problem) { setNote(problem.errors[0]); return }
    let emptied = 0
    setDoc((d) => ({
      ...d,
      objects: d.objects.flatMap((o) => {
        const i = ids.indexOf(o.id)
        if (i < 0) return [o]
        if (!out[i].paths.length) { emptied++; return [] }
        return [{ ...o, paths: out[i].paths, shapes: undefined }]
      }),
    }))
    setNote(emptied
      ? `overlap removed; ${emptied} object${emptied === 1 ? ' was' : 's were'} completely covered and deleted`
      : `overlap removed across ${targets.length} objects`)
  }

  const runOffset = (delta: number) => {
    const bad: string[] = []
    const next = new Map<string, Pt[][]>()
    for (const o of selectedObjs) {
      const r = offsetOp(o.paths, delta)
      if (r.errors.length) bad.push(`${o.name}: ${r.errors[0]}`)
      else next.set(o.id, r.paths)
    }
    if (!next.size) { setNote(bad[0] ?? 'nothing to offset'); return }
    setDoc((d) => ({
      ...d,
      objects: d.objects.map((o) =>
        next.has(o.id) ? { ...o, paths: next.get(o.id)!, shapes: undefined } : o),
    }))
    setNote(bad.length
      ? `${next.size} offset; ${bad[0]}`
      : `${next.size} outline${next.size === 1 ? '' : 's'} ${delta > 0 ? 'grown' : 'shrunk'} by ${Math.abs(delta)} mm`)
  }

  const runSimplify = () => {
    let before = 0, after = 0
    const next = new Map<string, { paths: Pt[][]; shapes?: Shape[] }>()
    for (const o of selectedObjs) {
      // An object with editable nodes gets its NODES cleaned, which keeps its
      // curves; only a raw polyline is thinned point by point. Running the
      // polyline simplifier over a Bézier outline would throw the curves away
      // and leave a shape nobody could get back.
      if (o.shapes?.length) {
        const c = cleanNodes(o.shapes)
        before += o.shapes.reduce((n, s) => n + s.nodes.length, 0)
        after += c.shapes.reduce((n, s) => n + s.nodes.length, 0)
        next.set(o.id, { paths: shapesToPaths(c.shapes), shapes: c.shapes })
      } else {
        const r = simplifyPaths(o.paths)
        before += o.paths.reduce((n, p) => n + p.length, 0)
        after += r.paths.reduce((n, p) => n + p.length, 0)
        next.set(o.id, { paths: r.paths })
      }
    }
    if (!next.size) return
    setDoc((d) => ({
      ...d,
      objects: d.objects.map((o) => {
        const v = next.get(o.id)
        return v ? { ...o, paths: v.paths, ...(v.shapes ? { shapes: v.shapes } : {}) } : o
      }),
    }))
    setNote(before === after ? 'already minimal — nothing to remove'
      : `${before - after} point${before - after === 1 ? '' : 's'} removed (${before} → ${after})`)
  }

  const runJoin = () => {
    if (selectedObjs.length < 1) return
    // Across the whole selection, not object by object: the case this exists
    // for is an import that arrived as a pile of separate segments, and those
    // land as separate OBJECTS.
    const all = selectedObjs.flatMap((o) => shapesOf(o))
    const j = joinShapes(all)
    if (!j.joined) { setNote('no ends close enough to join'); return }
    replaceSelection(shapesToPaths(j.shapes), 'joined')
    // Put the joined shapes back so the result stays node-editable — the only
    // operation here whose output IS the same nodes that went in.
    const keeper = selectedObjs[0]
    patch(keeper.id, (o) => ({ ...o, shapes: j.shapes, paths: shapesToPaths(j.shapes) }))
    const rings = j.shapes.filter((s) => s.closed).length
    setNote(`${j.joined} join${j.joined === 1 ? '' : 's'}${rings ? `, ${rings} closed into ${rings === 1 ? 'a ring' : 'rings'}` : ''}`)
  }

  /** Cut the selected outline at the node the Nodes tool has active. */
  const runSplit = () => {
    if (!selected || !activeNode) { setNote('pick a node with the Nodes tool first'); return }
    const shapes = shapesOf(selected)
    const r = splitShapeAt(shapes[activeNode.s], activeNode.i)
    if (r.errors.length) { setNote(r.errors[0]); return }
    const next = [...shapes.slice(0, activeNode.s), ...r.shapes, ...shapes.slice(activeNode.s + 1)]
    setShapes(selected.id, next)
    setActiveNode(null)
    setNote(r.shapes.length === 2 ? 'cut into two outlines' : 'ring opened at that node')
  }

  // --- arrange -------------------------------------------------------------

  /**
   * Apply a per-object geometric change, carrying EVERY piece of geometry.
   *
   * paths, shapes, angle guides and the entry/exit markers all live in
   * document mm. Any one of them left behind is a bug that only shows up
   * later and somewhere else, which is why they are mapped together here and
   * in the drag handler and nowhere else.
   */
  const mapObjects = (ids: readonly string[], f: (o: EmbObject) => (p: Pt) => Pt) =>
    setDoc((d) => ({
      ...d,
      objects: d.objects.map((o) => {
        if (!ids.includes(o.id)) return o
        const m = f(o)
        return {
          ...o,
          paths: o.paths.map((p) => p.map(m)),
          ...(o.shapes ? {
            shapes: o.shapes.map((sh) => ({
              ...sh,
              nodes: sh.nodes.map((n) => {
                const at = m({ x: n.x, y: n.y })
                return { ...n, x: at.x, y: at.y, hIn: n.hIn && m(n.hIn), hOut: n.hOut && m(n.hOut) }
              }),
            })),
          } : {}),
          ...(o.guides ? { guides: o.guides.map((g) => ({ a: m(g.a), b: m(g.b) })) } : {}),
          ...(o.entry ? { entry: m(o.entry) } : {}),
          ...(o.exit ? { exit: m(o.exit) } : {}),
        }
      }),
    }))

  const runAlign = (edge: AlignEdge) => {
    const boxes = selectedObjs.map(objectBox).filter((b): b is Box => !!b)
    if (boxes.length < 2) { setNote('select two or more objects to align'); return }
    const deltas = alignDeltas(boxes, edge)
    const ids = selectedObjs.map((o) => o.id)
    mapObjects(ids, (o) => {
      const d = deltas[ids.indexOf(o.id)] ?? { x: 0, y: 0 }
      return (p) => ({ x: p.x + d.x, y: p.y + d.y })
    })
    setNote(`aligned ${boxes.length} objects`)
  }

  const runDistribute = (horizontal: boolean) => {
    const boxes = selectedObjs.map(objectBox).filter((b): b is Box => !!b)
    if (boxes.length < 3) { setNote('select three or more objects to distribute'); return }
    const deltas = distributeDeltas(boxes, horizontal)
    const ids = selectedObjs.map((o) => o.id)
    mapObjects(ids, (o) => {
      const d = deltas[ids.indexOf(o.id)] ?? { x: 0, y: 0 }
      return (p) => ({ x: p.x + d.x, y: p.y + d.y })
    })
    setNote(`spaced ${boxes.length} objects evenly`)
  }

  const runMirror = (horizontal: boolean) => {
    if (!selBox) { setNote('select something to mirror'); return }
    // About the selection's own centre, so pressing it twice puts everything
    // back exactly where it was.
    const c = boxCentreOf(selBox)
    const about = horizontal ? c.x : c.y
    mapObjects(selectedObjs.map((o) => o.id), () => (p) => mirrorPt(p, about, horizontal))
    setNote(`mirrored ${horizontal ? 'left to right' : 'top to bottom'}`)
  }

  const runDuplicate = () => {
    if (!selectedObjs.length) return
    const copies = selectedObjs.map((o) => ({
      ...structuredClone(o),
      id: newObject().id,
      name: `${o.name} copy`,
    }))
    const shift = (p: Pt) => ({ x: p.x + DUPLICATE_OFFSET_MM, y: p.y + DUPLICATE_OFFSET_MM })
    for (const c of copies) {
      c.paths = c.paths.map((p) => p.map(shift))
      if (c.shapes) {
        c.shapes = c.shapes.map((sh) => ({
          ...sh,
          nodes: sh.nodes.map((n) => {
            const at = shift({ x: n.x, y: n.y })
            return { ...n, x: at.x, y: at.y, hIn: n.hIn && shift(n.hIn), hOut: n.hOut && shift(n.hOut) }
          }),
        }))
      }
      if (c.guides) c.guides = c.guides.map((g) => ({ a: shift(g.a), b: shift(g.b) }))
      if (c.entry) c.entry = shift(c.entry)
      if (c.exit) c.exit = shift(c.exit)
    }
    // Copies sew straight after the objects they came from, which keeps the
    // sequence readable and usually avoids a thread change.
    const lastAt = Math.max(...selectedObjs.map((o) => doc.objects.findIndex((q) => q.id === o.id)))
    setDoc((d) => {
      const out = [...d.objects]
      out.splice(lastAt + 1, 0, ...copies)
      return { ...d, objects: out }
    })
    setSelectedIds(copies.map((c) => c.id))
    setNote(`duplicated ${copies.length} object${copies.length === 1 ? '' : 's'}`)
  }

  const addPaths = (paths: Pt[][], label: string, colors?: readonly string[]) => {
    const b = bounds(paths)
    const dx = b ? -(b.minX + b.maxX) / 2 : 0
    const dy = b ? -(b.minY + b.maxY) / 2 : 0

    // Group by the colour the artwork already states, THEN split each colour
    // into regions. Regioning the whole file at once would make a white
    // highlight sitting on a red disc into a hole in the red — visually true
    // of the drawing, but wrong as stitching, where it is a white object
    // sewn on top. Within one colour, a counter really is a hole.
    const byColour = new Map<string, Pt[][]>()
    paths.forEach((ring, i) => {
      const key = colors?.[i] ?? ''
      const bucket = byColour.get(key)
      if (bucket) bucket.push(ring)
      else byColour.set(key, [ring])
    })

    const made: EmbObject[] = []
    for (const [colour, group] of byColour) {
      // Split into regions so a letter keeps its counter as a hole of the
      // SAME object, while separate shapes become separate objects the user
      // can colour and treat independently.
      const regions = toRegions(group)
      const parts: Pt[][][] = regions.length ? regions : [group]
      parts.forEach((g, i) => {
        made.push(newObject({
          name: parts.length > 1 || byColour.size > 1
            ? `${label} ${made.length + 1}` : label,
          // No colour in the file at all — a plain outline drawing — still
          // gets the rotating palette, because there is nothing to read.
          color: colour || PALETTE[made.length % PALETTE.length],
          type: 'fill',
          paths: g.map((ring) => [...ring, ring[0]].map((p) => ({ x: p.x + dx, y: p.y + dy }))),
        }))
        void i
      })
    }
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
  /**
   * Largest backdrop worth keeping in a project file, bytes.
   *
   * A project is autosaved into localStorage, which is a few megabytes in
   * total. Past this the picture would be most of the file and could crowd
   * out the thing that actually matters — the design — so it is still shown
   * and still traceable, just not stored.
   */
  const BACKDROP_MAX_BYTES = 3_000_000

  const importImage = async (file: File) => {
    // The menu stays open until a file actually arrives — see Menu.tsx
    // for why closing it on the click killed the picker.
    closeAllMenus()
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(String(fr.result))
        fr.onerror = () => reject(new Error('could not read that file'))
        fr.readAsDataURL(file)
      })
      if (!/^data:image\//i.test(dataUrl)) throw new Error('that is not an image')
      // Measure it before storing, so pxPerMm is set from the real pixels.
      const probe = await loadImage(dataUrl)
      const pxPerMm = probe.naturalWidth / doc.hoop.widthMm
      const origin = {
        x: -doc.hoop.widthMm / 2,
        y: -(probe.naturalHeight / pxPerMm) / 2,
      }
      const tooBig = dataUrl.length > BACKDROP_MAX_BYTES
      if (tooBig) {
        // Shown and traceable, but not written into the project — and said
        // out loud, because a picture that silently failed to save is the
        // same surprise as one that never saved at all.
        setBackdrop(await decodeBackdrop({ dataUrl, pxPerMm, origin, name: file.name }))
        setNote(
          `${file.name} loaded for tracing, but it is ${(dataUrl.length / 1e6).toFixed(1)} MB `
          + 'and will NOT be saved with the project — scale it down first if you need it kept.',
        )
      } else {
        setDoc((d) => ({ ...d, backdrop: { dataUrl, pxPerMm, origin, name: file.name } }))
        setNote(`${file.name} loaded — click a colour with the Wand to trace it`)
      }
      setTool('wand')
    } catch (e) {
      alert(`Could not load that image: ${(e as Error).message}`)
    }
  }

  /**
   * Turn a stored backdrop into something the canvas and the wand can use.
   *
   * The raster is the wand's input and has to be the image's OWN pixels, so
   * it is read back off a canvas at natural size rather than from whatever
   * the screen happens to be showing.
   */
  const decodeBackdrop = async (b: Backdrop) => {
    const bitmap = await loadImage(b.dataUrl)
    const cv = document.createElement('canvas')
    cv.width = bitmap.naturalWidth
    cv.height = bitmap.naturalHeight
    const ctx = cv.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('could not read the image')
    ctx.drawImage(bitmap, 0, 0)
    const id = ctx.getImageData(0, 0, cv.width, cv.height)
    return {
      bitmap,
      raster: { data: id.data, width: cv.width, height: cv.height },
      pxPerMm: b.pxPerMm,
      origin: b.origin,
      name: b.name,
    }
  }

  /**
   * Keep the live backdrop in step with the document's.
   *
   * ONE path for both cases — a freshly imported picture and one that came
   * back with an opened project — because two paths means two chances for
   * the canvas to show one thing while the wand traces another.
   */
  const backdropUrl = doc.backdrop?.dataUrl
  useEffect(() => {
    if (!doc.backdrop) {
      // Only drop the live one if it came from the document. An oversized
      // picture is shown without being stored, and must survive an edit.
      setBackdrop((b) => (b && b.fromDoc ? null : b))
      return
    }
    let alive = true
    decodeBackdrop(doc.backdrop)
      .then((b) => { if (alive) setBackdrop({ ...b, fromDoc: true }) })
      .catch(() => { if (alive) setNote('The saved reference image could not be decoded') })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backdropUrl])

    /**
   * Regenerate an object's outlines from its text spec.
   *
   * Lettering is re-rasterised on every edit rather than transformed, so a
   * face change or a longer word comes out as that face and that word, not
   * as the old shapes stretched to fit.
   */
  const applyText = useCallback((id: string, spec: TextSpec, at?: Pt) => {
    if (spec.mode === 'satin') { applySatinText(id, spec, at); return }
    const out = textToOutlines(spec)
    for (const w of out.warnings) setNote(w)
    if (!out.paths.length) return
    // Lettering on a baseline path is already where it belongs.
    const paths = out.absolute
      ? out.paths
      : at ? out.paths.map((r) => r.map((q) => ({ x: q.x + at.x, y: q.y + at.y }))) : null
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
    // textToOutlines centres everything on the origin, so the letter centres
    // need the SAME offset the paths just got — otherwise the handles sit at
    // the document origin while the lettering is wherever it was placed.
    const obj = doc.objects.find((o) => o.id === id)
    const ob = at || out.absolute ? null : obj && bounds(obj.paths)
    const off = out.absolute
      ? { x: 0, y: 0 }
      : at ?? (ob ? { x: (ob.minX + ob.maxX) / 2, y: (ob.minY + ob.maxY) / 2 } : { x: 0, y: 0 })
    setLetterBoxes({
      id,
      letters: out.letters.map((l) => ({ ...l, centre: { x: l.centre.x + off.x, y: l.centre.y + off.y } })),
    })
  }, [doc.objects])

  /**
   * Lettering as SATIN: one two-rail column per stroke.
   *
   * The strokes become their own objects rather than one object holding many
   * rail pairs, because a two-rail column is a PAIR of paths by definition —
   * putting six strokes in one object would leave no way to say which rail
   * goes with which. Separate objects also let a single stroke be re-angled
   * or re-densified without touching the rest of the word.
   */
  const applySatinText = useCallback((id: string, spec: TextSpec, at?: Pt) => {
    const { columns, warnings } = textToColumns(spec)
    for (const w of warnings) setNote(w)
    if (!columns.length) return
    // Columns come out in canvas mm; centre them like the outline path does.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const c of columns) for (const q of [...c.left, ...c.right]) {
      if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x
      if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y
    }
    const old = doc.objects.find((o) => o.id === id)
    const b = at ? null : old && bounds(old.paths)
    const to = at ?? (b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : { x: 0, y: 0 })
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    const place = (p: Pt[]) => p.map((q) => ({ x: q.x - cx + to.x, y: q.y - cy + to.y }))

    const made = columns.map((c, i) => newObject({
      name: `${spec.content} ${c.ch}${i + 1}`,
      color: old?.color ?? PALETTE[doc.objects.length % PALETTE.length],
      type: 'satin',
      twoRail: true,
      // Only the FIRST carries the spec: it is one line of text, and copying
      // the spec onto every stroke would regenerate the whole word once per
      // stroke the next time anything changed.
      ...(i === 0 ? { text: spec } : {}),
      paths: [place(c.left), place(c.right)],
    }))
    setDoc((d) => ({
      ...d,
      objects: [...d.objects.filter((o) => o.id !== id && !o.name.startsWith(`${spec.content} `)), ...made],
    }))
    setSelectedId(made[0].id)
    setSim(null)
    setNote(`${columns.length} satin stroke(s)`)
  }, [doc.objects, setDoc, setSelectedId])

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
    setLetterBoxes({
      id: obj.id,
      letters: out.letters.map((l) => ({ ...l, centre: { x: l.centre.x + at.x, y: l.centre.y + at.y } })),
    })
    setNote(`${out.widthMm.toFixed(1)} × ${out.heightMm.toFixed(1)} mm — edit the words in Properties`)
  }, [doc.objects.length, setDoc, setSelectedId])

  /** Trace whatever colour was clicked into a new object. */
  const wandAt = useCallback((p: Pt) => {
    if (!backdrop) { setNote('Load a backdrop image first — File ▸ Backdrop image…'); return }
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
    // THE COLOUR IT TRACED, not the next one off a palette. A crest with
    // three colours in it came out as thirty — one per click, cycling
    // through a rainbow — which is not a design anyone can look at, and
    // meant thirty thread changes for a three-thread logo.
    const obj = newObject({
      name: `${colourName(res.color)} ${n + 1}`,
      color: res.color,
      type: 'fill',
      paths: res.paths.map((ring) => [...ring, { ...ring[0] }]),
    })
    setDoc((d) => ({ ...d, objects: [...d.objects, obj] }))
    setSelectedId(obj.id)
    setSim(null)
    if (!res.warnings.length) setNote(`Traced ${res.paths.length} contour(s) from ${backdrop.name}`)
  }, [backdrop, wandTolerance, doc.objects.length, setDoc, setSelectedId])

  const importSvg = async (file: File) => {
    // The menu stays open until a file actually arrives — see Menu.tsx
    // for why closing it on the click killed the picker.
    closeAllMenus()
    try {
      const v = parseSvgToPaths(await file.text(), file.name.replace(/\.svg$/i, ''))
      addPaths(v.paths, v.name, v.colors)
      setNote(v.skipped
        ? `${v.skipped} element(s) skipped — convert text to outlines first`
        : `Imported ${v.name}`)
      setTimeout(fit, 0)
    } catch (e) {
      alert(`Could not read that SVG: ${(e as Error).message}`)
    }
  }

  const importDstReference = async (file: File) => {
    // The menu stays open until a file actually arrives — see Menu.tsx
    // for why closing it on the click killed the picker.
    closeAllMenus()
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
    // Appliqué jobs need the fabric cut before the machine can finish them.
    const cut = appliqueCutSvg(doc)
    if (cut) download(`${n}-applique-cut.svg`, cut, 'image/svg+xml')
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

  /**
   * Machine formats beyond DST.
   *
   * Each is a real encoder checked against pyembroidery — a separate
   * implementation by other authors — on every fixture, needle for needle.
   * Renaming a .dst would be quicker and would produce a file no machine
   * could read.
   */
  const exportFormat = (fmt: 'exp' | 'jef') => {
    if (!total) return
    const centered = centerPlan(plan)
    if (fmt === 'exp') {
      download(`${base()}.exp`, writeExp(centered))
      setNote('Exported .exp — Melco. Carries no colours; keep the .col beside it.')
    } else {
      download(`${base()}.jef`, writeJef(centered))
      setNote(
        'Exported .jef — Janome. JEF stores a thread INDEX, not a colour, '
        + 'so the colours are snapped to the nearest of Janome’s 78.')
    }
  }

  /**
   * Everything at once: every machine format, both colour sidecars, the 1:1
   * template, any appliqué cut file, and the run sheet.
   *
   * The reason this is one button rather than six presses is that the files
   * MUST come from one stitch plan. Exporting a DST, changing something, then
   * exporting a JEF gives a shop two files that look like the same design and
   * sew differently — and nothing in either file says which is which.
   */
  const exportEverything = () => {
    if (!total) return
    const centered = centerPlan(plan)
    const n = base()
    download(`${n}.dst`, writeDst(centered, n))
    download(`${n}.exp`, writeExp(centered))
    download(`${n}.jef`, writeJef(centered))
    download(`${n}.col`, writeCol(centered), 'text/plain')
    download(`${n}.edr`, writeEdr(centered))
    download(`${n}-template.svg`, placementTemplateSvg(doc, centered), 'image/svg+xml')
    const cut = appliqueCutSvg(doc)
    if (cut) download(`${n}-applique-cut.svg`, cut, 'image/svg+xml')
    download(`${n}-runsheet.html`, runSheetHtml(doc, stats, machine), 'text/html')
    setNote(`Exported ${n} in 3 machine formats + sidecars, template and run sheet — all from one plan`)
  }

  const saveProject = () => {
    download(projectFilename(doc), serialize(doc, true), 'application/json')
    setNote(`Saved ${projectFilename(doc)}`)
  }

  const openProject = async (file: File) => {
    // The menu stays open until a file actually arrives — see Menu.tsx
    // for why closing it on the click killed the picker.
    closeAllMenus()
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
  const atMm = (e: MoveLike): Pt => {
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
      const hit = pickObject(pickable, p, PICK_PX / view.scale)
      setSelectedId(hit?.id ?? null)
      setActiveNode(null)
      if (!hit) panning.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy }
      return
    }
    if (pickingBaseline && selected?.text) {
      // Picking the object whose outline the lettering will follow. Checked
      // before the ordinary select handling, which would otherwise just
      // change the selection and lose the lettering being edited.
      if (e.button !== 0) return
      // A generous radius on purpose. Picking a baseline is a deliberate
      // act with a prompt on screen, and the usual 4 px is tuned for
      // telling two overlapping objects apart — not for hitting a hairline
      // curve, which is exactly what a baseline usually is.
      const hit = pickObject(pickable, atMm(e), (PICK_PX * 4) / view.scale)
      setPickingBaseline(false)
      if (!hit || hit.id === selected.id) {
        setNote(hit ? 'lettering cannot follow its own outline' : 'nothing there — baseline unchanged')
        return
      }
      // The LONGEST of its outlines: an object may hold several, and the one
      // meant as a baseline is the one that goes somewhere.
      const line = [...hit.paths].sort((a, b) => b.length - a.length)[0]
      if (!line || line.length < 2) { setNote('that object has no line to follow'); return }
      applyText(selected.id, { ...selected.text, path: line.map((q) => ({ ...q })) })
      setNote(`lettering now follows "${hit.name}"`)
      return
    }
    if (tool === 'select' || (cmdHeld && !drawing())) {
      if (e.button !== 0) return
      const p = atMm(e)
      const snapshot = () => selectedObjs.map((o) => ({ id: o.id, paths: o.paths }))
      // Start/end markers are grabbed before anything else: they sit ON the
      // object, so testing the object first would make them unreachable.
      if (selected && (selected.entry || selected.exit)) {
        const tol = HANDLE_PX / view.scale
        for (const which of ['entry', 'exit'] as const) {
          const at = selected[which]
          if (at && Math.hypot(p.x - at.x, p.y - at.y) <= tol) {
            history.begin()
            endDrag.current = { id: selected.id, which }
            return
          }
        }
      }
      // Per-letter handles take precedence over the object's own handles:
      // they sit INSIDE the selection box, so anything else would make them
      // unreachable.
      if (selected?.text && selected.text.mode === 'fill' && letterBoxes?.id === selected.id) {
        const tol = HANDLE_PX / view.scale
        for (let i = 0; i < letterBoxes.letters.length; i++) {
          const c = letterBoxes.letters[i].centre
          if (Math.hypot(p.x - c.x, p.y - c.y) <= tol) {
            history.begin()
            letterDrag.current = {
              id: selected.id, index: i, start: p,
              from: selected.text.nudges?.[i] ?? { dx: 0, dy: 0, rot: 0 },
            }
            return
          }
        }
      }
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
      const hit = pickObject(pickable, p, PICK_PX / view.scale)
      if (hit) {
        // Shift toggles membership; a plain click replaces the selection,
        // unless the object is already in it — dragging a multi-selection by
        // one of its members must move all of them, not reset to that one.
        // Clicking a member picks the whole GROUP. Alt reaches past it to
        // the one object, which is the standard way into a group and the
        // only way to edit one member without ungrouping first.
        const asGroup = (id: string) => (e.altKey ? [id] : expandToGroups([id]))
        let ids: string[]
        if (e.shiftKey) {
          ids = selectedIds.includes(hit.id)
            ? selectedIds.filter((x) => !asGroup(hit.id).includes(x))
            : [...selectedIds, ...asGroup(hit.id)]
        } else {
          ids = selectedIds.includes(hit.id) ? selectedIds : asGroup(hit.id)
        }
        ids = [...new Set(ids)]
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
    if (tool === 'angle') {
      // A guide belongs to an object, so there has to be one. Clicking with
      // nothing selected picks whatever is under the cursor rather than
      // silently doing nothing.
      const target = selected ?? pickObject(pickable, p, PICK_PX / view.scale)
      if (!target) { setSelectedIds([]); return }
      if (!selected || selected.id !== target.id) setSelectedIds([target.id])
      // A click ON an existing guide removes it; drawing a new one is a drag.
      const tol = PICK_PX / view.scale
      const hit = (target.guides ?? []).findIndex((g) => segDist(g.a, g.b, p) <= tol)
      if (hit >= 0) {
        patch(target.id, (o) => ({ ...o, guides: (o.guides ?? []).filter((_, i) => i !== hit) }))
        return
      }
      guideDraw.current = { id: target.id, a: p }
      setGuideDrag({ a: p, b: p })
      return
    }
    if (tool === 'text') { addText(p); return }
    if (tool === 'stitch') {
      // Shift adds to the selection; a plain click replaces it.
      const hit = pickStitch(plan, p, STITCH_PICK_PX / view.scale)
      if (hit) {
        setPicked((prev) => e.shiftKey
          ? (prev.some((r) => r.block === hit.block && r.index === hit.index)
            ? prev.filter((r) => !(r.block === hit.block && r.index === hit.index))
            : [...prev, hit])
          : [hit])
      } else if (!e.shiftKey) {
        setPicked([])
      }
      pickDrag.current = { start: p, moved: false }
      return
    }
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

  // --- auto-scroll -----------------------------------------------------------
  //
  // Zoomed in far enough to place nodes accurately, the shape you are tracing
  // is bigger than the window — so a pen path runs into the edge and stops,
  // with no way to continue without abandoning the gesture to pan. Every
  // digitizing program solves this the same way: when the cursor reaches the
  // edge DURING a gesture, the view follows it.
  //
  // It is deliberately gesture-only. A view that drifted whenever the pointer
  // rested near an edge would be unusable for reading the design.

  const [autoScroll, setAutoScroll] = useState(
    () => localStorage.getItem(AUTOSCROLL_KEY) !== 'off',
  )
  useEffect(() => {
    localStorage.setItem(AUTOSCROLL_KEY, autoScroll ? 'on' : 'off')
  }, [autoScroll])

  /** The last pointer position, replayed by the loop as the view moves. */
  const lastMove = useRef<MoveLike | null>(null)
  const scrollRaf = useRef(0)
  /**
   * The CURRENT move handler and preference, for the loop to call.
   *
   * The loop outlives the render that started it, and the handler it closed
   * over reads `view` — so calling that captured copy would map the cursor
   * through the view as it was when the gesture began, and the rubber-band
   * would be pinned to where the design used to be. Going through a ref
   * means every frame uses the handler from the latest render, which is the
   * one that knows where the view is now.
   */
  const moveRef = useRef<(e: MoveLike) => void>(() => {})
  const autoScrollRef = useRef(true)

  /**
   * Is a gesture in progress?
   *
   * Every ref the move handler consults, because each one represents a
   * half-finished action that the edge of the window should not be allowed to
   * cut short. `panning` is excluded: the user is already moving the view by
   * hand, and helping would fight them.
   */
  const gestureLive = () =>
    !panning.current && (
      drawing()
      || !!dragging.current || !!marquee.current || !!endDrag.current
      || !!letterDrag.current || !!nodeDrag.current || !!penDrag.current
      || !!pickDrag.current || !!guideDraw.current || !!xform.current
      || arcPts.current.length > 0
    )

  const stopAutoScroll = () => {
    if (scrollRaf.current) cancelAnimationFrame(scrollRaf.current)
    scrollRaf.current = 0
  }

  const runAutoScroll = () => {
    stopAutoScroll()
    let last = performance.now()
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const wrap = wrapRef.current
      const e = lastMove.current
      if (!wrap || !e || !gestureLive() || !autoScrollRef.current) { scrollRaf.current = 0; return }
      // Replay FIRST, so the preview catches up with the pan applied at the
      // end of the previous frame before this frame moves the view again.
      moveRef.current(e)
      const vel = edgeVelocity(wrap.getBoundingClientRect(), e.clientX, e.clientY)
      // Zero on both axes means the pointer came back to the comfortable
      // middle: stop the loop rather than keep it spinning at no speed.
      if (!vel.vx && !vel.vy) { scrollRaf.current = 0; return }
      setView((v) => {
        const { dx, dy } = panStep(vel, dt, v.scale)
        return { ...v, cx: v.cx + dx, cy: v.cy + dy }
      })
      scrollRaf.current = requestAnimationFrame(step)
    }
    scrollRaf.current = requestAnimationFrame(step)
  }

  // A gesture can end anywhere — mouse up, Escape, a finished shape — so the
  // loop is never left running on its own authority.
  useEffect(() => stopAutoScroll, [])

  const onMove = (e: React.MouseEvent) => {
    lastMove.current = { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey }
    handleMove(lastMove.current)
    if (!autoScroll) return
    if (!gestureLive()) { stopAutoScroll(); return }
    if (!scrollRaf.current) runAutoScroll()
  }

  const handleMove = (e: MoveLike) => {
    const pan = panning.current
    if (pan) {
      setView((v) => ({ ...v, cx: pan.cx - (e.clientX - pan.x) / v.scale, cy: pan.cy - (e.clientY - pan.y) / v.scale }))
      return
    }
    if (marquee.current) {
      setMarquee({ a: marquee.current, b: atMm(e) })
      return
    }
    const ed = endDrag.current
    if (ed) {
      patch(ed.id, (o) => ({ ...o, [ed.which]: atMm(e) }))
      return
    }
    const ld = letterDrag.current
    if (ld && selected?.text) {
      const p = atMm(e)
      applyText(ld.id, {
        ...selected.text,
        nudges: {
          ...selected.text.nudges,
          [ld.index]: {
            ...ld.from,
            dx: ld.from.dx + (p.x - ld.start.x),
            dy: ld.from.dy + (p.y - ld.start.y),
          },
        },
      })
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
          // ONE mapper, applied to every piece of geometry the object owns.
          // Each of these has been forgotten here at least once; anything that
          // lives in document mm and is not transformed stays behind when the
          // object moves.
          const mapPaths = (ps: Pt[][]) =>
            x.kind === 'move' ? movePaths(ps, p.x - x.start.x, p.y - x.start.y)
              : x.kind === 'rotate' ? rotatePaths(ps, pivot, rad)
              : fitPaths(ps, x.from, to!)
          const m = (q: Pt) => mapPaths([[q]])[0][0]
          const paths = mapPaths(it.paths)
          // Shapes carry the editable outline; a transform that ignored them
          // would resurrect the pre-drag curve the next time it was flattened.
          const shapes = o.shapes?.map((sh) => ({
            ...sh,
            nodes: sh.nodes.map((n) => {
              const at = m({ x: n.x, y: n.y })
              return {
                ...n, x: at.x, y: at.y,
                hIn: n.hIn && m(n.hIn), hOut: n.hOut && m(n.hOut),
              }
            }),
          }))
          // Angle guides are geometry too — they say which way the bars run
          // AT A PLACE on the column, so they have to travel with it.
          const guides = o.guides?.map((g) => ({ a: m(g.a), b: m(g.b) }))
          return {
            ...o, paths,
            ...(shapes ? { shapes } : {}),
            ...(guides ? { guides } : {}),
            ...(o.entry ? { entry: m(o.entry) } : {}),
            ...(o.exit ? { exit: m(o.exit) } : {}),
          }
        }),
      }))
      return
    }
    // Cursor feedback: a handle, a grabbable object, or nothing.
    if ((tool === 'select' || (cmdHeld && !drawing())) && !panning.current) {
      const p = atMm(e)
      const b = selBox
      const h = b ? hitHandle(b, p, HANDLE_PX / view.scale) : null
      setHoverCursor(h ? handleCursor(h) : pickObject(pickable, p, PICK_PX / view.scale) ? 'move' : null)
    }
    const gd = guideDraw.current
    if (gd) { setGuideDrag({ a: gd.a, b: atMm(e) }); return }
    const pd = pickDrag.current
    if (pd && tool === 'stitch') {
      const p = atMm(e)
      if (!pd.moved && Math.hypot(p.x - pd.start.x, p.y - pd.start.y) < STITCH_PICK_PX / view.scale) return
      pd.moved = true
      // Dragging from empty space bands a range; dragging from a selected
      // stitch moves the selection.
      if (picked.length) {
        editStitches((plan) => moveStitches(plan, picked, p.x - pd.start.x, p.y - pd.start.y))
        pd.start = p
      } else {
        setMarquee({ a: pd.start, b: p })
      }
      return
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

  // Refreshed on EVERY render, not inside onMove: during an auto-scroll the
  // pointer is stationary, so no move event fires and the loop would keep
  // calling the handler from the render where the gesture started.
  moveRef.current = handleMove
  autoScrollRef.current = autoScroll

  const onUp = (e: React.MouseEvent) => {
    stopAutoScroll()
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
    if (pickDrag.current) {
      const pd = pickDrag.current
      pickDrag.current = null
      if (pd.moved && !picked.length) {
        const b = atMm(e)
        setMarquee(null)
        setPicked(pickStitchesIn(plan, {
          minX: Math.min(pd.start.x, b.x), minY: Math.min(pd.start.y, b.y),
          maxX: Math.max(pd.start.x, b.x), maxY: Math.max(pd.start.y, b.y),
        }))
      }
      return
    }
    if (guideDraw.current) {
      const g = guideDraw.current
      guideDraw.current = null
      setGuideDrag(null)
      const b = atMm(e)
      // A guide is a DIRECTION, so a slipped click has no angle to read.
      // Refusing a short one is better than storing whatever noise the mouse
      // happened to produce.
      if (Math.hypot(b.x - g.a.x, b.y - g.a.y) * view.scale < 8) {
        setNote('drag across the column to set an angle — a click is too short to read one')
        return
      }
      patch(g.id, (o) => ({ ...o, guides: [...(o.guides ?? []), { a: g.a, b }] }))
      return
    }
    if (endDrag.current) { endDrag.current = null; history.end(); return }
    if (letterDrag.current) { letterDrag.current = null; history.end(); return }
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
      if ((e.key === 'Delete' || e.key === 'Backspace') && tool === 'stitch' && picked.length) {
        e.preventDefault()
        const n = picked.length
        editStitches((plan) => deleteStitches(plan, picked))
        setPicked([])
        setNote(`${n} stitch${n === 1 ? '' : 'es'} deleted`)
        return
      }
      // Delete the SELECTION. Last of the three Delete handlers, because the
      // stitch and node tools are editing something inside an object and
      // their Delete means that smaller thing; with any other tool there is
      // nothing smaller selected, so it means the object.
      //
      // The `typing` guard above is what keeps Backspace in a name field
      // from deleting the design instead of a character.
      if ((e.key === 'Delete' || e.key === 'Backspace')
        && tool !== 'stitch' && tool !== 'node' && selectedObjs.length) {
        e.preventDefault()
        deleteSelection()
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
      // Cmd/Ctrl+D duplicates, as it does in every vector program. Checked
      // before the single-letter tool picks, or the 'd' would just switch to
      // the Draw tool with the modifier ignored.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        runDuplicate()
        return
      }
      if (e.metaKey || e.ctrlKey) return
      const pick: Record<string, Tool> = {
        v: 'select', n: 'node', b: 'pen', a: 'arc', c: 'column', g: 'angle', w: 'wand', t: 'text', s: 'stitch',
        r: 'rect', e: 'ellipse', p: 'polygon', d: 'freehand',
      }
      const t = pick[e.key.toLowerCase()]
      if (t) { cancelDraw(); setTool(t) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool, finishPolygon, finishPen, finishColumn, cancelDraw, history, selected, activeNode, shapesOf, setShapes, picked, editStitches])


  // --- render -------------------------------------------------------------
  return (
    <div className="app">
      {/* TWO rows, not seven.
          Row 1 is a menu bar: everything you press once and then forget for
          an hour. Row 2 is the tool palette: the things you press constantly,
          which must stay visible and in the same place every time. */}
      <div className="toolbar">
        <div className="menubar">
          <Menu label="File" width={230}>
            <MenuLabel>Artwork</MenuLabel>
            <FilePick label="Import SVG…" accept=".svg,image/svg+xml" onPick={importSvg} />
            <FilePick label="Open DST as reference…" accept=".dst,.DST" onPick={importDstReference} />
            <FilePick label="Backdrop image…" accept="image/png,image/jpeg,image/gif,image/webp" onPick={importImage} />
            {backdrop && (
              <MenuItem
                hint={backdrop.fromDoc ? backdrop.name : `${backdrop.name} — not saved with the project`}
                onClick={() => {
                  setDoc((d) => ({ ...d, backdrop: undefined }))
                  setBackdrop(null)
                  setNote(null)
                }}>Clear backdrop image</MenuItem>
            )}
            {reference && <MenuItem onClick={() => setReference(null)}>Clear DST reference</MenuItem>}
            <MenuSep />
            <MenuLabel>Project</MenuLabel>
            <FilePick label="Open project…" accept={`.${FILE_EXT},application/json`} onPick={openProject} />
            <MenuItem disabled={!doc.objects.length} onClick={saveProject}
              hint="Keeps everything editable — this is the file to come back to">
              Save project
            </MenuItem>
          </Menu>

          <Menu label="Export" width={260}>
            <MenuItem disabled={!total} onClick={exportPackage}
              hint="DST, colour sidecars, run sheet and a 1:1 template">
              Export package
            </MenuItem>
            <MenuItem disabled={!total} onClick={exportEverything}
              hint="Every format and sidecar, all from ONE stitch plan">
              All formats
            </MenuItem>
            <MenuSep />
            <MenuLabel>One machine file</MenuLabel>
            <MenuItem disabled={!total} onClick={exportDstOnly}
              hint="Tajima. No colours travel with a DST">.dst</MenuItem>
            <MenuItem disabled={!total} onClick={() => exportFormat('exp')}
              hint="Melco. Verified against pyembroidery; carries no colours">.exp</MenuItem>
            <MenuItem disabled={!total} onClick={() => exportFormat('jef')}
              hint="Janome. Colours snap to Janome’s built-in 78">.jef</MenuItem>
          </Menu>

          <div className="group tight">
            <button onClick={history.undo} disabled={!history.canUndo}
              title="Undo (Cmd/Ctrl+Z)">Undo</button>
            <button onClick={history.redo} disabled={!history.canRedo}
              title="Redo (Cmd/Ctrl+Shift+Z)">Redo</button>
          </div>

          {/* Everything here changes the OUTLINE, never the stitch settings,
              and everything produces objects that can still be node-edited. */}
          <Menu label="Shape" width={290}>
            <MenuLabel>Combine</MenuLabel>
            {BOOL_OPS.map((op) => (
              <MenuItem key={op} disabled={selectedObjs.length < 2}
                onClick={() => runBoolean(op)}
                hint={
                  op === 'union' ? 'One outline from all of them'
                    : op === 'difference' ? 'Cut the objects in FRONT out of the back one'
                    : op === 'intersection' ? 'Keep only what they all cover'
                    : 'Keep everything except where they overlap'
                }>
                {BOOL_LABEL[op]}
              </MenuItem>
            ))}
            <MenuItem disabled={doc.objects.length < 2} onClick={runRemoveOverlap}
              hint="Nothing sewn twice — double density is where needles break">
              Remove overlap
            </MenuItem>
            <MenuSep />
            <MenuLabel>Outline</MenuLabel>
            <MenuItem disabled={!selectedObjs.length} onClick={() => runOffset(1)}
              hint="Closed shapes only">Grow 1 mm</MenuItem>
            <MenuItem disabled={!selectedObjs.length} onClick={() => runOffset(-1)}
              hint="Closed shapes only">Shrink 1 mm</MenuItem>
            <MenuItem disabled={!selectedObjs.length} onClick={runSimplify}
              hint="Drops points that add nothing; keeps curves on outlines that have them">
              Simplify
            </MenuItem>
            <MenuItem disabled={!selectedObjs.length} onClick={runJoin}
              hint="Weld outlines whose ends meet; a closed loop becomes a ring">
              Join ends
            </MenuItem>
            <MenuItem disabled={!selected || !activeNode} onClick={runSplit}
              hint={activeNode ? 'Cut at the selected node' : 'Pick a node with the Nodes tool first'}>
              Split at node
            </MenuItem>
          </Menu>

          <Menu label="Arrange" width={260}>
            <MenuLabel>Align</MenuLabel>
            <div className="keep-open menu-grid">
              {([['left', 'Left'], ['centreX', 'Centre'], ['right', 'Right'],
                ['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']] as const).map(([edge, lbl]) => (
                <button key={edge} disabled={selectedObjs.length < 2}
                  onClick={() => runAlign(edge as AlignEdge)}>{lbl}</button>
              ))}
            </div>
            <MenuItem disabled={selectedObjs.length < 3} onClick={() => runDistribute(true)}
              hint="Evens the GAPS, not the centres">Space evenly across</MenuItem>
            <MenuItem disabled={selectedObjs.length < 3} onClick={() => runDistribute(false)}
              hint="Evens the GAPS, not the centres">Space evenly down</MenuItem>
            <MenuSep />
            <MenuItem disabled={!selectedObjs.length} onClick={() => runMirror(true)}
              hint="About the selection’s own centre, so twice puts it back">Flip left ↔ right</MenuItem>
            <MenuItem disabled={!selectedObjs.length} onClick={() => runMirror(false)}>
              Flip top ↔ bottom
            </MenuItem>
            <MenuItem disabled={!selectedObjs.length} onClick={runDuplicate}
              hint="Cmd/Ctrl+D">Duplicate</MenuItem>
            <MenuSep />
            <MenuItem disabled={selectedObjs.length < 2} onClick={groupSelection}
              hint="A name, a visibility and a lock — NOT a change to the sewing order">
              Group
            </MenuItem>
            <MenuItem disabled={!selectedObjs.some((o) => o.group)} onClick={ungroupSelection}>
              Ungroup
            </MenuItem>
            {/* A group's own switches live here rather than as three more
                buttons on every row of the sequence — that panel is a
                reading of the RUN, and a group is not something the machine
                knows about. */}
            {selGroup && (
              <>
                <div className="row wide keep-open">
                  <label>Group name</label>
                  <input type="text" value={selGroup.name}
                    onChange={(e) => patchGroup(selGroup.id, (x) => ({ ...x, name: e.target.value }))} />
                </div>
                <MenuItem onClick={() => patchGroup(selGroup.id, (x) => ({ ...x, hidden: !x.hidden }))}
                  active={!!selGroup.hidden}
                  hint="Hides every member without forgetting which were hidden on their own">
                  {selGroup.hidden ? 'Show the group' : 'Hide the group'}
                </MenuItem>
                <MenuItem onClick={() => patchGroup(selGroup.id, (x) => ({ ...x, locked: !x.locked }))}
                  active={!!selGroup.locked}
                  hint="Locked members cannot be picked on the canvas">
                  {selGroup.locked ? 'Unlock the group' : 'Lock the group'}
                </MenuItem>
                <MenuItem onClick={() => setSelectedIds(
                  doc.objects.filter((o) => o.group === selGroup.id).map((o) => o.id))}>
                  Select the whole group
                </MenuItem>
              </>
            )}
          </Menu>

          {/* Letterforms somebody digitized, reused. A system font is a set
              of drawings for ink on paper; this is the other thing. */}
          <Menu label="Alphabet" width={250}>
            <MenuLabel>Capture a letter</MenuLabel>
            {alphabets.length > 0 ? (
              <div className="row wide keep-open">
                <label>Into</label>
                <select value={activeAlphabet ?? alphabets[0].id}
                  onChange={(e) => setActiveAlphabet(e.target.value)}>
                  {alphabets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} — {alphabetCoverage(a).join('') || 'empty'}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="row wide keep-open">
                <label>New alphabet</label>
                <input type="text" value={newAlphabetName}
                  onChange={(e) => setNewAlphabetName(e.target.value)} />
              </div>
            )}
            <div className="row wide keep-open">
              <label>This outline is the character</label>
              <input type="text" value={glyphChar} maxLength={1} placeholder="A"
                onChange={(e) => setGlyphChar(e.target.value)} />
            </div>
            <MenuItem
              disabled={!selectedObjs.length || glyphChar.trim().length !== 1}
              onClick={() => captureGlyph(glyphChar)}
              hint="Capture CAPITALS — a letter is normalised by its own height">
              Capture selection
            </MenuItem>
            {alphabets.length > 0 && (
              <>
                <MenuSep />
                <MenuLabel>Set a word</MenuLabel>
                <div className="row wide keep-open">
                  <label>Words</label>
                  <input type="text" value={alphabetWord}
                    onChange={(e) => setAlphabetWord(e.target.value)} />
                </div>
                <div className="row wide keep-open">
                  <label>Letter height (mm)</label>
                  <input type="number" value={alphabetSize} min={1} max={200}
                    onChange={(e) => setAlphabetSize(Number(e.target.value))} />
                </div>
                <MenuItem onClick={() => {
                  const a = alphabets.find((q) => q.id === activeAlphabet) ?? alphabets[0]
                  setFromAlphabet(a, alphabetWord, alphabetSize)
                }}>Set word</MenuItem>
              </>
            )}
          </Menu>

          <Menu label="View" width={210}>
            <MenuItem onClick={fit} hint="Or press the Fit button">Fit to window</MenuItem>
            <div className="row wide">
              <span className="dim">
                Scroll to zoom. Hold Space and drag to pan from any tool, or drag with
                the middle button.
              </span>
            </div>
            <label className="check keep-open"
              title="While you are drawing or dragging, move the view when the pointer reaches the edge — so a path can run off the side of the window and keep going">
              <input type="checkbox" checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)} />
              Auto-scroll while drawing
            </label>
            <MenuSep />
            <MenuLabel>Show</MenuLabel>
            {([
              ['showArt', 'Artwork'], ['showStitches', 'Stitches'], ['showJumps', 'Jumps'],
              ['showPoints', 'Needle points'], ['showGrid', 'Grid'],
            ] as const).map(([k, lbl]) => (
              <label key={k} className="check keep-open">
                <input type="checkbox" checked={opts[k]}
                  onChange={(e) => setOpts((o) => ({ ...o, [k]: e.target.checked }))} />
                {lbl}
              </label>
            ))}
            <label className="check keep-open"
              title="Shade areas with more thread than the fabric can take">
              <input type="checkbox" checked={showDensity}
                onChange={(e) => setShowDensity(e.target.checked)} />
              Density
            </label>
            <MenuSep />
            <MenuLabel>Garment colour</MenuLabel>
            <div className="row wide keep-open">
              {/* Thread reads completely differently on navy than on white —
                  a cream fill that looks like lettering on white disappears
                  on ash. This is the one thing the preview can do that no
                  amount of zooming can: show it against what it is going on. */}
              <div className="swatches">
                {GARMENTS.map((g) => (
                  <button
                    key={g.name}
                    className={`gsw${(doc.fabric ?? '') === g.color ? ' on' : ''}`}
                    style={{ background: g.color }}
                    title={g.name}
                    onClick={() => setDoc((d) => ({ ...d, fabric: g.color }), 'fabric')}
                  />
                ))}
                <button
                  className={`gsw none${doc.fabric ? '' : ' on'}`}
                  title="No garment — plain background"
                  onClick={() => setDoc((d) => {
                    const { fabric, ...rest } = d
                    void fabric
                    return rest
                  }, 'fabric')}
                >×</button>
              </div>
            </div>
            <div className="row wide keep-open">
              <label>Other</label>
              <input type="color" value={doc.fabric ?? '#ffffff'}
                title="Any garment colour"
                onChange={(e) => setDoc((d) => ({ ...d, fabric: e.target.value }), 'fabric')} />
              <span className="dim">{doc.fabric ? colourName(doc.fabric) : 'none'}</span>
            </div>
            {tool === 'wand' && (
              <>
                <MenuSep />
                <MenuLabel>Wand tolerance</MenuLabel>
                <label className="check keep-open"
                  title="How far a colour may differ and still be included">
                  <input type="range" min={2} max={80} step={1}
                    value={Math.round(wandTolerance * 100)}
                    onChange={(e) => setWandTolerance(Number(e.target.value) / 100)} />
                  <span className="dim">{Math.round(wandTolerance * 100)}%</span>
                </label>
              </>
            )}
          </Menu>

          <Menu label="Machine" title={doc.hoop.note ?? ''} width={300}>
            <div className="row wide keep-open">
              <label>Hoop</label>
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
            </div>
            <div className="row wide keep-open">
              <label>Bracket spacing</label>
              <select
                value={doc.spacing} title="Limits which hoops physically mount"
                onChange={(e) => setDoc((d) => ({ ...d, spacing: e.target.value as Spacing }))}
              >
                {SPACINGS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="row wide keep-open">
              <label>Needles</label>
              <input
                type="number" min={1} max={24} value={machine.needles}
                title="More colour blocks than this means a mid-run re-thread"
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (Number.isFinite(v)) setMachine((m) => ({ ...m, needles: Math.max(1, v) }))
                }}
              />
            </div>
            {doc.hoop.note && (
              <div className="row wide"><span className="dim">{doc.hoop.note}</span></div>
            )}
          </Menu>

          <div className="group tight">
            <button onClick={fit} title="Fit the design to the window">Fit</button>
            <span className="dim">{doc.hoop.name}</span>
          </div>
        </div>

        {/* Open designs. The commonest real job is "make this one look like
            that one", and copying between two files should not mean saving,
            closing, opening and finding it again. */}
        <div className="doctabs">
          {parked.map((p, i) => {
            const d = i === activeTab ? doc : p.state?.present
            const name = d?.name || 'untitled'
            const empty = !d || d.objects.length === 0
            return (
              <div key={p.id} className={`doctab${i === activeTab ? ' on' : ''}`}
                title={empty ? `${name} — empty` : `${name} — ${d.objects.length} objects`}
                onClick={() => switchTo(i)}>
                <span className="dt-name">{empty ? name : `* ${name}`}</span>
                {parked.length > 1 && (
                  <button className="dt-x" title="Close this design"
                    onClick={(e) => { e.stopPropagation(); closeDocument(i) }}>×</button>
                )}
              </div>
            )
          })}
          <button className="dt-new" title="Start another design" onClick={newDocument}>+</button>
          {/* Renaming lives here because the name is a property of the
              DOCUMENT, and the tab is the only place a document is visible
              as a whole. */}
          <input className="dt-rename" value={doc.name}
            title="Name this design — it becomes the file name on export"
            onChange={(e) => setDoc((d) => ({ ...d, name: e.target.value }), 'doc.name')} />
        </div>

        {/* The numeric transform bar.
            Dragging a handle is how you place something; TYPING is how you
            make it exactly 3 inches wide because that is what the customer
            asked for and what the quote says. Both, always. */}
        <div className="xform">
          <div className="group tight">
            <label>Units</label>
            {(['mm', 'inch'] as const).map((u) => (
              <button key={u} className={unit === u ? 'primary' : undefined}
                onClick={() => setUnit(u)}>{u === 'mm' ? 'mm' : 'inch'}</button>
            ))}
          </div>
          <div className="group tight">
            <label>Size</label>
            <XField
              value={selBox ? selBox.maxX - selBox.minX : null} unit={unit}
              title="Width of the selection. Type a size — 3, 3 1/2, or 76mm."
              onCommit={(v) => resizeSelection(v, null)} />
            <button className={lockAspect ? 'primary' : undefined}
              title={lockAspect
                ? 'Proportions locked — the other side follows'
                : 'Proportions free — each side is set on its own'}
              onClick={() => setLockAspect((v) => !v)}>{lockAspect ? '🔒' : '🔓'}</button>
            <XField
              value={selBox ? selBox.maxY - selBox.minY : null} unit={unit}
              title="Height of the selection."
              onCommit={(v) => resizeSelection(null, v)} />
            <ScaleField onCommit={(pct) => scaleSelection(pct / 100)} />
          </div>
          <div className="group tight">
            <label title="Turns the selection by this much. The geometry does not remember an angle, so this is a turn, not a setting.">Turn</label>
            <input
              type="number" step={15} value={turnDeg} style={{ width: 62 }}
              disabled={!selBox}
              onChange={(e) => setTurnDeg(Number(e.target.value))} />
            <button disabled={!selBox || !turnDeg} onClick={() => turnSelection(turnDeg)}>°</button>
          </div>
          <div className="group tight">
            <label title="Where the middle of the selection sits, measured from the middle of the hoop">Centre</label>
            <XField
              value={selBox ? (selBox.minX + selBox.maxX) / 2 : null} unit={unit} signed
              title="Across — negative is left of the hoop's middle."
              onCommit={(v) => moveSelectionTo(v, null)} />
            <XField
              value={selBox ? (selBox.minY + selBox.maxY) / 2 : null} unit={unit} signed
              title="Down — negative is above the hoop's middle."
              onCommit={(v) => moveSelectionTo(null, v)} />
            <button disabled={!selBox} title="Put the selection in the middle of the hoop"
              onClick={() => { moveSelectionTo(0, null); moveSelectionTo(null, 0) }}>centre</button>
          </div>
        </div>

        {/* The palette. Pressed constantly, so it stays out and stays put. */}
        <div className="palette">
          <div className="group">
            <label>Draw</label>
            {TOOLS.map((t) => (
              <button
                key={t.id}
                className={`tool${tool === t.id ? ' on' : ''}`}
                title={t.hint}
                onClick={() => { cancelDraw(); closeAllMenus(); setTool(t.id) }}
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
        </div>
      </div>

      <div className="body">
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

        {/* ONE right column, as in every digitizing package: the design
            tree on top — what is in this file, in order, with a picture of
            each — and a tabbed inspector under it. The canvas gets
            everything else, because the canvas is the work. */}
        <div className="side right">
          <div className="tree">
            <div className="tree-head">
              <span className="tree-no">1</span>
              <Thumb paths={doc.objects.flatMap((o) => o.paths)} bounds={designBounds}
                color="#9aa4b2" size={20} outline />
              <b>{doc.name}</b>
              <span className="dim">{doc.objects.length}</span>
            </div>
            {!doc.objects.length && (
              <div className="empty">
                Draw with the tools above, import an SVG, or load a reference image and
                trace it with the Wand.
              </div>
            )}
            {doc.objects.map((o, i) => {
              const g = o.group ? doc.groups.find((q) => q.id === o.group) : null
              const hidden = !objectVisible(o, doc.groups)
              return (
                <div
                  key={o.id}
                  data-row={i}
                  className={`trow${selectedIds.includes(o.id) ? ' sel' : ''}`
                    + `${dragOver === i ? ' drop' : ''}${rowDrag === i ? ' dragging' : ''}`}
                  onClick={(e) => {
                    if (e.shiftKey) {
                      const anchor = doc.objects.findIndex((q) => q.id === selectedId)
                      const from = anchor < 0 ? i : anchor
                      const [lo, hi] = from < i ? [from, i] : [i, from]
                      setSelectedIds(doc.objects.slice(lo, hi + 1).map((q) => q.id))
                    } else if (e.metaKey || e.ctrlKey) {
                      setSelectedIds(selectedIds.includes(o.id)
                        ? selectedIds.filter((x) => x !== o.id)
                        : [...selectedIds, o.id])
                    } else {
                      setSelectedId(o.id)
                    }
                  }}
                >
                  {/* Drag to change when this sews. Two arrow buttons per row
                      meant twenty-five presses to bring the last object to
                      the front. */}
                  <span className="tree-no grip" title="Drag to change when this sews"
                    onPointerDown={(e) => {
                      e.preventDefault(); e.stopPropagation()
                      setRowDrag(i); setDragOver(i)
                    }}>1:{i + 1}</span>
                  <Thumb paths={o.paths} bounds={designBounds} color={o.color}
                    dim={hidden} outline={o.type === 'run' || o.type === 'bean'} />
                  <span className="trow-name" title={`${o.name}${g ? ` — in “${g.name}”` : ''}`}>
                    {o.name}
                  </span>
                  <span className="trow-type">{TYPE_WORD[o.type]}</span>
                  <button className="eye" title={o.visible ? 'Hide' : 'Show'}
                    onClick={(e) => { e.stopPropagation(); patch(o.id, (x) => ({ ...x, visible: !x.visible })) }}>
                    {o.visible ? '●' : '○'}
                  </button>
                </div>
              )
            })}
            {doc.objects.length > 0 && (
              <>
                <div className={`endpad${dragOver === doc.objects.length ? ' drop' : ''}`}>
                  {rowDrag !== null ? 'sew last' : ''}
                </div>
                <div className="tree-foot">
                  <button disabled={!selectedObjs.length} onClick={deleteSelection}
                    title="Delete the selected objects (Delete)">
                    Delete{selectedObjs.length > 1 ? ` ${selectedObjs.length}` : ''}
                  </button>
                  <button disabled={!selectedObjs.length} onClick={runDuplicate}
                    title="Duplicate (Cmd/Ctrl+D)">Duplicate</button>
                  <button
                    title="Remove every object from this design"
                    onClick={() => {
                      if (!window.confirm(
                        `Remove all ${doc.objects.length} objects from “${doc.name}”?`
                        + '\n\nCmd/Ctrl+Z puts them back.')) return
                      setDoc((d) => ({ ...d, objects: [], groups: [] }))
                      setSelectedIds([])
                    }}>Clear all</button>
                </div>
              </>
            )}
          </div>

          <div className="tabs">
            {(['colour', 'object', 'design'] as const).map((t) => (
              <button key={t} className={inspector === t ? 'on' : undefined}
                onClick={() => setInspector(t)}>
                {t === 'colour' ? 'Colour' : t === 'object' ? 'Object' : 'Design'}
              </button>
            ))}
          </div>

          <div className="inspector">
          {inspector === 'colour' && (
            <>
              {/* The run, by thread. Each row is one threading: the operator
                  puts this cone on, sews that much, and stops. */}
              <div className="row wide">
                <span className="dim">
                  {threads} threading{threads === 1 ? '' : 's'} on a {machine.needles}-needle
                  machine{threads > machine.needles ? ' — re-threading mid-run' : ''}.
                  Click a row to select what it sews.
                </span>
              </div>
              {blocks.filter((b) => b.number > 0).map((b) => (
                <div key={blockKey(b)}>
                <div className="crow"
                  onClick={() => setSelectedIds(b.objects.map((q) => q.object.id))}>
                  <span className="cno">{b.number}</span>
                  {/* The swatch IS the colour control: this is the list you
                      are looking at when you decide two blocks should be
                      one thread, so it is where the change belongs. */}
                  <label className="cswatch" style={{ background: b.color }}
                    title={`${colourName(b.color)} — click to change the colour of all ${b.objects.length} object${b.objects.length === 1 ? '' : 's'} in this block`}
                    onClick={(e) => e.stopPropagation()}>
                    <input type="color" value={b.color}
                      onChange={(e) => setColourOf(b.objects.map((q) => q.object.id), e.target.value)} />
                  </label>
                  <div className="cbody">
                    <span className="cname"
                      title={b.thread
                        ? spoolLabel(b.thread)
                        : 'No thread chosen — the run sheet will say UNASSIGNED'}>
                      {b.thread ? spoolLabel(b.thread) : `${colourName(b.color)} — no thread chosen`}
                    </span>
                    <span className="dim">{(b.stitches ?? 0).toLocaleString()} stitches</span>
                  </div>
                  <button title="Give this block the same colour as the one above it, so they sew as one threading"
                    disabled={blocks.filter((q) => q.number > 0)[0] === b}
                    onClick={(e) => {
                      e.stopPropagation()
                      const live = blocks.filter((q) => q.number > 0)
                      const above = live[live.indexOf(b) - 1]
                      if (!above) return
                      setColourOf(b.objects.map((q) => q.object.id), above.color)
                      setNote('Merged into the block above — one threading fewer')
                    }}>merge up</button>
                  <button title="Choose the thread for this block"
                    onClick={(e) => {
                      e.stopPropagation()
                      const id = b.objects[0].object.id
                      setPicking(picking === id ? null : id)
                      setNewName(colourName(b.color))
                    }}>
                    {b.thread ? 'change' : 'choose'}
                  </button>
                </div>
                {picking === b.objects[0].object.id && (
                  <div className="picker">
                    {/* The rack first: these are cones this shop owns, which
                        is the only list where picking the nearest colour is
                        also picking something that can be threaded today. */}
                    {!!rack.length && (
                      <>
                        <div className="menu-label">Your rack — nearest first</div>
                        {nearestSpools(rack, b.color).map((sp) => (
                          <button key={sp.id} className="pick"
                            onClick={() => assignThread(b.objects[0].object.id, sp)}>
                            <span className="cswatch small" style={{ background: sp.color }} />
                            <span>{spoolLabel(sp)}</span>
                          </button>
                        ))}
                      </>
                    )}
                    <div className="menu-label">
                      Brother palette{rack.length ? '' : ' — the only chart that ships, because it comes from the file format itself'}
                    </div>
                    {(() => {
                      const m = nearestMachineThread(b.color)
                      return m ? (
                        <button className="pick"
                          onClick={() => assignThread(b.objects[0].object.id, {
                            brand: m.brand, code: m.thread.code, name: m.thread.name,
                          })}>
                          <span className="cswatch small" style={{ background: m.thread.color }} />
                          <span>{m.brand} {m.thread.code} {m.thread.name}</span>
                        </button>
                      ) : null
                    })()}
                    <div className="menu-label">Add a cone from your rack</div>
                    <div className="row wide">
                      <input type="text" value={newBrand} placeholder="Madeira Classic 40"
                        onChange={(e) => setNewBrand(e.target.value)} />
                    </div>
                    <div className="row wide">
                      <input type="text" value={newCode} placeholder="code, e.g. 1025"
                        onChange={(e) => setNewCode(e.target.value)} />
                    </div>
                    <div className="row wide">
                      <input type="text" value={newName} placeholder="name, e.g. Dark Orange"
                        onChange={(e) => setNewName(e.target.value)} />
                    </div>
                    <button className="pick primary" disabled={!newCode.trim()}
                      title="Saves it to your rack as well, so it is one click next time"
                      onClick={() => {
                        const sp = newSpool(newBrand, newCode, b.color, newName)
                        saveRack([...rack, sp])
                        setNewCode('')
                        assignThread(b.objects[0].object.id, sp)
                      }}>
                      Use it, and keep it on my rack
                    </button>
                  </div>
                )}
                </div>
              ))}
              {!blocks.some((b) => b.number > 0) && (
                <div className="empty">Nothing is being sewn yet.</div>
              )}
            </>
          )}
          {inspector === 'design' && (
            <>
              <fieldset>
                <legend>Tie-in and tie-off</legend>
                <div className="row wide">
                  <span className="dim">
                    The few stitches that stop a thread end pulling out — placed at the start
                    and end of every colour, and either side of every trim.
                  </span>
                </div>
                <div className="row wide">
                  <label className="check">
                    <input type="checkbox" checked={doc.tie.tieIn}
                      onChange={(e) => setDocTie({ tieIn: e.target.checked })} />
                    Tie in
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={doc.tie.tieOff}
                      onChange={(e) => setDocTie({ tieOff: e.target.checked })} />
                    Tie off
                  </label>
                </div>
                <div className="row wide">
                  <label>Style</label>
                  <div className="checks">
                    <button
                      className={doc.tie.style === 'zigzag' ? 'primary' : undefined}
                      title="Each lock stitch lands in its own hole — safest, and the default"
                      onClick={() => setDocTie({ style: 'zigzag' })}>Zigzag</button>
                    <button
                      className={doc.tie.style === 'backtrack' ? 'primary' : undefined}
                      title="Retraces the same holes: invisible, but harder on the thread, and a machine's short-stitch filter can swallow it"
                      onClick={() => setDocTie({ style: 'backtrack' })}>Backtrack</button>
                  </div>
                </div>
                <Num label="Tie stitch length (mm)" value={doc.tie.length} step={0.1} min={0.5} max={4}
                  onChange={(v) => setDocTie({ length: v })} />
                <Num label="Tie stitches" value={doc.tie.stitches} step={1} min={2} max={8}
                  onChange={(v) => setDocTie({ stitches: Math.round(v) })} />
                {(!doc.tie.tieIn || !doc.tie.tieOff) && (
                  <div className="row wide">
                    <span className="warn">
                      Thread ends will pull out unless the machine places its own locks.
                    </span>
                  </div>
                )}
              </fieldset>
              <fieldset>
                <legend>Hoop and machine</legend>
                <div className="row"><label>Hoop</label><span>{doc.hoop.name}</span></div>
                <div className="row">
                  <label>Sewing field</label>
                  <span>{doc.hoop.widthMm.toFixed(0)} × {doc.hoop.heightMm.toFixed(0)} mm</span>
                </div>
                <div className="row"><label>Bracket</label><span>{doc.spacing}</span></div>
                <div className="row"><label>Needles</label><span>{machine.needles}</span></div>
                <div className="row wide">
                  <span className="dim">Change these in the Machine menu.</span>
                </div>
              </fieldset>
            </>
          )}
          {inspector === 'object' && !selected && (
            <div className="empty">Select an object to set its stitch type and parameters.</div>
          )}
          {inspector === 'object' && selected && (
            <>
              {/* Presets first: reaching for a known-good recipe is quicker
                  than setting a dozen numbers, and it is what most jobs
                  actually want. */}
              <fieldset>
                <legend>Stitch style</legend>
                <div className="row wide">
                  <div className="checks">
                    {[...BUILT_IN_PRESETS, ...userPresets].map((p) => (
                      <button key={p.id} title={p.note ?? 'A saved stitch style'}
                        onClick={() => applyPreset(p)}>
                        {p.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="row wide">
                  <div className="checks">
                    <button onClick={savePreset} title="Save this object's settings as a reusable style">
                      Save current…
                    </button>
                    {userPresets.map((p) => (
                      <button key={`x${p.id}`} title={`Delete "${p.name}"`}
                        onClick={() => deletePreset(p.id)}>
                        ✕ {p.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="row wide">
                  <span className="dim">
                    A style sets how an object is sewn — never its shape, colour or
                    thread. The built-ins are starting points: check each against a
                    sewout on the fabric you are using.
                  </span>
                </div>
              </fieldset>

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
                  <option value="applique">Appliqué — fabric, with stops</option>
                  <option value="knockdown">Knockdown — flatten pile first</option>
                  <option value="none">Off — stitches nothing</option>
                </select>
              </div>
              <Text label="Name" value={selected.name}
                onChange={(v) => patch(selected.id, (o) => ({ ...o, name: v }), 'name')} />
              <div className="row">
                <label>{selectedObjs.length > 1 ? `Colour — all ${selectedObjs.length}` : 'Colour'}</label>
                {/* Applies to the WHOLE selection. Recolouring a traced logo
                    one object at a time is thirty colour pickers, and the
                    reason to recolour is usually to make several objects
                    share ONE thread. */}
                <input type="color" value={selected.color}
                  onChange={(e) => setColourOf(selectedObjs.map((o) => o.id), e.target.value)} />
              </div>

              <fieldset>
                <legend>Thread</legend>
                <Text label="Brand" placeholder="Isacord" tag="brand" value={selected.thread.brand ?? ''}
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
                  {/* Text on a path. The baseline is another object's
                      outline, which means it can be drawn, node-edited and
                      reshaped with the tools that are already here rather
                      than with a second set that only lettering can use. */}
                  <div className="row wide">
                    <label>Baseline</label>
                    <div className="checks">
                      <button
                        className={selected.text.path?.length ? 'primary' : undefined}
                        title="Pick another object's outline for the lettering to follow. Its direction is the reading direction — drawn the other way, the letters hang below the line, which is how the bottom of a crest is set."
                        onClick={() => setPickingBaseline((v) => !v)}>
                        {selected.text.path?.length ? 'On a path' : 'Follow a path…'}
                      </button>
                      {!!selected.text.path?.length && (
                        <button onClick={() => applyText(selected.id, { ...selected.text!, path: undefined })}>
                          Straight
                        </button>
                      )}
                    </div>
                  </div>
                  {pickingBaseline && (
                    <div className="row wide">
                      <span className="warn">Click the object whose outline the lettering should follow.</span>
                    </div>
                  )}
                  {!!selected.text.path?.length && (
                    <div className="row wide">
                      <label>If the path is a different length</label>
                      <div className="checks">
                        {([['keep-size', 'Keep letter height'], ['fit-path', 'Fit to path']] as const).map(([v, lbl]) => (
                          <button key={v}
                            className={(selected.text!.pathFit ?? 'keep-size') === v ? 'primary' : undefined}
                            title={v === 'keep-size'
                              ? 'The letters stay the height you set; the line runs past the end of a short path and says so'
                              : 'The line is scaled to span the path exactly — which CHANGES the letter height'}
                            onClick={() => applyText(selected.id, { ...selected.text!, pathFit: v })}>
                            {lbl}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="row wide">
                    <button
                      title="Turn this lettering into ordinary outlines. The words stop being editable — this is the one-way door, and it is explicit."
                      onClick={() => convertTextToOutlines(selected.id)}>
                      Convert to outlines
                    </button>
                  </div>
                  <div className="row wide">
                    <label>Stitched as</label>
                    <div className="checks">
                      {(['fill', 'satin'] as const).map((m) => (
                        <button
                          key={m}
                          className={selected.text!.mode === m ? 'primary' : undefined}
                          title={m === 'satin'
                            ? 'A column down each stroke — what lettering under ~20 mm wants'
                            : 'Tatami inside the letter outline'}
                          onClick={() => applyText(selected.id, { ...selected.text!, mode: m })}>
                          {m === 'fill' ? 'Fill' : 'Satin'}
                        </button>
                      ))}
                    </div>
                  </div>
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

              <fieldset>
                <legend>Start and end</legend>
                <div className="row wide">
                  <label className="dim">
                    {selected.entry || selected.exit
                      ? 'Drag the green start and red end markers on the canvas'
                      : 'Automatic — set a start or end to control travel'}
                  </label>
                </div>
                <div className="row wide">
                  <div className="checks">
                    <button onClick={() => {
                      const b = objectBox(selected)
                      if (b) patch(selected.id, (o) => ({ ...o, entry: { x: b.minX, y: b.minY } }))
                    }}>Set start</button>
                    <button onClick={() => {
                      const b = objectBox(selected)
                      if (b) patch(selected.id, (o) => ({ ...o, exit: { x: b.maxX, y: b.maxY } }))
                    }}>Set end</button>
                    <button
                      disabled={!selected.entry && !selected.exit}
                      onClick={() => patch(selected.id, (o) => ({ ...o, entry: undefined, exit: undefined }))}>
                      Automatic
                    </button>
                  </div>
                </div>
              </fieldset>

              {(selected.type === 'run' || selected.type === 'bean') && (
                <fieldset>
                  <legend>{selected.type === 'bean' ? 'Bean' : 'Run'}</legend>
                  <Num label="Stitch length (mm)" value={selected.run.length} min={0.5} max={12}
                    onChange={(v) => patch(selected.id, (o) => ({ ...o, run: { ...o.run, length: v } }), 'run.length')} />
                  {/* A motif run is still a run — same path, same length, same
                      place in the sequence — so it is a style here rather than
                      a sixth entry in the stitch-type list. Bean is a triple
                      pass of the line itself and has no motif form. */}
                  {selected.type === 'run' && (
                    <div className="row wide">
                      <label>Style</label>
                      <div className="checks">
                        {([['plain', 'Plain line'], ['motif', 'Motif']] as const).map(([v, lbl]) => (
                          <button key={v}
                            className={selected.run.style === v ? 'primary' : undefined}
                            onClick={() => patch(selected.id, (o) => ({ ...o, run: { ...o.run, style: v } }))}>
                            {lbl}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </fieldset>
              )}

              {((selected.type === 'run' && selected.run.style === 'motif')
                || (selected.type === 'fill' && selected.fill.style === 'motif')) && (
                <fieldset>
                  <legend>Motif</legend>
                  <div className="row">
                    <label>Shape</label>
                    <select value={selected.motif.id}
                      onChange={(e) => patch(selected.id, (o) => ({ ...o, motif: { ...o.motif, id: e.target.value } }))}>
                      {MOTIFS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                  </div>
                  <Num label="Length along (mm)" value={selected.motif.widthMm} step={0.5} min={MIN_MOTIF_MM} max={40}
                    onChange={(v) => patch(selected.id, (o) => ({ ...o, motif: { ...o.motif, widthMm: v } }), 'motif.w')} />
                  <Num label="Height across (mm)" value={selected.motif.heightMm} step={0.5} min={0} max={40}
                    onChange={(v) => patch(selected.id, (o) => ({ ...o, motif: { ...o.motif, heightMm: v } }), 'motif.h')} />
                  <Num label="Gap between (mm)" value={selected.motif.gapMm} step={0.5} min={0} max={20}
                    onChange={(v) => patch(selected.id, (o) => ({ ...o, motif: { ...o.motif, gapMm: v } }), 'motif.g')} />
                  <div className="row wide">
                    <span className="dim">
                      Only whole motifs are stamped; anything left over at the end runs plain.
                    </span>
                  </div>
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
                  <Num label="Bar lean (°)" value={selected.satin.lean} step={5} min={-70} max={70}
                    onChange={(v) => patch(selected.id, (o) => ({ ...o, satin: { ...o.satin, lean: v } }), 'satin.lean')} />
                  <UnderlayPicker
                    value={selected.satin.underlay}
                    order={SATIN_UNDERLAY_ORDER}
                    options={[
                      { id: 'center', label: 'Centre run' },
                      { id: 'edge', label: 'Edge runs' },
                      { id: 'zigzag', label: 'Zigzag' },
                    ]}
                    onChange={(next) => patch(selected.id, (o) => ({ ...o, satin: { ...o.satin, underlay: next } }))} />
                  <div className="row wide">
                    <label>
                      <input type="checkbox" checked={selected.satin.split.enabled}
                        onChange={(e) => patch(selected.id, (o) => ({
                          ...o, satin: { ...o.satin, split: { ...o.satin.split, enabled: e.target.checked } },
                        }))} />
                      {' '}Split long stitches
                    </label>
                    <span className="dim">
                      The bar IS the stitch, so a column over {MAX_SATIN_MM} mm snags and is
                      refused. Splitting adds a penetration partway across so a wider one can
                      be sewn — up to {MAX_SPLIT_SATIN_MM} mm.
                    </span>
                  </div>
                  {selected.satin.split.enabled && (
                    <>
                      <Num label="Longest stitch (mm)" value={selected.satin.split.maxLength}
                        step={0.5} min={1} max={MAX_SATIN_MM}
                        onChange={(v) => patch(selected.id, (o) => ({
                          ...o, satin: { ...o.satin, split: { ...o.satin.split, maxLength: v } },
                        }), 'satin.split.maxLength')} />
                      <Num label="Split stagger (0–1)" value={selected.satin.split.stagger}
                        step={0.1} min={0} max={1}
                        onChange={(v) => patch(selected.id, (o) => ({
                          ...o, satin: { ...o.satin, split: { ...o.satin.split, stagger: v } },
                        }), 'satin.split.stagger')} />
                    </>
                  )}
                  <div className="row wide">
                    <label>Angle guides</label>
                    {selected.twoRail ? (
                      <span className="dim">
                        Not used on a two-rail column — its rungs already say which way
                        the bars run.
                      </span>
                    ) : (
                      <div className="checks">
                        <button
                          className={tool === 'angle' ? 'primary' : undefined}
                          title="Drag a line across the column to set the bar direction there"
                          onClick={() => setTool(tool === 'angle' ? 'select' : 'angle')}>
                          {selected.guides?.length
                            ? `${selected.guides.length} guide${selected.guides.length === 1 ? '' : 's'}`
                            : 'Draw (G)'}
                        </button>
                        {!!selected.guides?.length && (
                          <button onClick={() => patch(selected.id, (o) => ({ ...o, guides: undefined }))}>
                            Clear
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </fieldset>
              )}

              {selected.type === 'knockdown' && (
                <fieldset>
                  <legend>Knockdown</legend>
                  <div className="row wide">
                    <label className="dim">
                      Flattens pile on towelling and fleece. Put it FIRST in the
                      sewing sequence, under the design it supports.
                    </label>
                  </div>
                  <Num label="Row spacing (mm)" value={selected.knockdown.spacing} step={0.1} min={0.8} max={6}
                    onChange={(v) => patch(selected.id, (o) => ({ ...o, knockdown: { ...o.knockdown, spacing: v } }), 'kd.sp')} />
                  <Num label="Extend beyond edge (mm)" value={selected.knockdown.margin} step={0.5} min={0} max={10}
                    onChange={(v) => patch(selected.id, (o) => ({ ...o, knockdown: { ...o.knockdown, margin: v } }), 'kd.mg')} />
                  <Num label="Angle (°)" value={selected.knockdown.angle} step={5} min={-180} max={180}
                    onChange={(v) => patch(selected.id, (o) => ({ ...o, knockdown: { ...o.knockdown, angle: v } }), 'kd.an')} />
                  <Num label="Stitch length (mm)" value={selected.knockdown.length} step={0.5} min={1} max={12}
                    onChange={(v) => patch(selected.id, (o) => ({ ...o, knockdown: { ...o.knockdown, length: v } }), 'kd.ln')} />
                </fieldset>
              )}

              {selected.type === 'satin' && (
                <fieldset>
                  <legend>3D puff</legend>
                  <div className="row wide">
                    <div className="checks">
                      <label className="check">
                        <input type="checkbox" checked={selected.puff.enabled}
                          onChange={(e) => patch(selected.id, (o) => ({ ...o, puff: { ...o.puff, enabled: e.target.checked } }))} />
                        Sew over foam
                      </label>
                    </div>
                  </div>
                  {selected.puff.enabled && (
                    <>
                      <div className="row">
                        <label>Foam thickness</label>
                        <select value={String(selected.puff.thickness)}
                          onChange={(e) => patch(selected.id, (o) => ({ ...o, puff: { ...o.puff, thickness: Number(e.target.value) } }))}>
                          <option value="2">2 mm</option>
                          <option value="3">3 mm</option>
                          <option value="4">4 mm</option>
                          <option value="6">6 mm</option>
                        </select>
                      </div>
                      <Num label="Density ×" value={selected.puff.densityScale} step={0.05} min={0.4} max={1}
                        onChange={(v) => patch(selected.id, (o) => ({ ...o, puff: { ...o.puff, densityScale: v } }), 'puff.ds')} />
                      <div className="row wide">
                        <div className="checks">
                          <label className="check" title="Perforates the ends so the excess foam tears along the stitching">
                            <input type="checkbox" checked={selected.puff.capEnds}
                              onChange={(e) => patch(selected.id, (o) => ({ ...o, puff: { ...o.puff, capEnds: e.target.checked } }))} />
                            Cap the ends
                          </label>
                        </div>
                      </div>
                    </>
                  )}
                </fieldset>
              )}

              {selected.type === 'applique' && (
                <fieldset>
                  <legend>Appliqué</legend>
                  {/* The order is fixed because the machine and the operator
                      take turns; only the sizes are the digitizer's call. */}
                  <div className="row wide">
                    <label className="dim">
                      Placement run · STOP · tack-down · STOP · border
                    </label>
                  </div>
                  <Num label="Tack-down width (mm)" value={selected.applique.tackWidth} step={0.1} min={0.6} max={4}
                    onChange={(v) => patch(selected.id, (o) => ({ ...o, applique: { ...o.applique, tackWidth: v } }), 'ap.tw')} />
                  <Num label="Tack-down spacing (mm)" value={selected.applique.tackDensity} step={0.05} min={0.3} max={2}
                    onChange={(v) => patch(selected.id, (o) => ({ ...o, applique: { ...o.applique, tackDensity: v } }), 'ap.td')} />
                  <div className="row wide">
                    <label>Border</label>
                    <div className="checks">
                      <label className="check">
                        <input type="checkbox" checked={selected.applique.border}
                          onChange={(e) => patch(selected.id, (o) => ({ ...o, applique: { ...o.applique, border: e.target.checked } }))} />
                        Finish the cut edge
                      </label>
                    </div>
                  </div>
                  {selected.applique.border && (
                    <>
                      <div className="row wide">
                        <label>Edge style</label>
                        <div className="checks">
                          {(['satin', 'overlock'] as const).map((st) => (
                            <button
                              key={st}
                              className={selected.applique.borderStyle === st ? 'primary' : undefined}
                              title={st === 'overlock'
                                ? 'Leaned bars imitating a serged edge — what a ready-made patch has'
                                : 'An ordinary satin border, bars square to the edge'}
                              onClick={() => patch(selected.id, (o) => ({ ...o, applique: { ...o.applique, borderStyle: st } }))}>
                              {st === 'satin' ? 'Satin' : 'Faux overlock'}
                            </button>
                          ))}
                        </div>
                      </div>
                      <Num label="Border width (mm)" value={selected.applique.borderWidth} step={0.1} min={1} max={8}
                        onChange={(v) => patch(selected.id, (o) => ({ ...o, applique: { ...o.applique, borderWidth: v } }), 'ap.bw')} />
                      <Num label="Border spacing (mm)" value={selected.applique.borderDensity} step={0.05} min={0.2} max={1}
                        onChange={(v) => patch(selected.id, (o) => ({ ...o, applique: { ...o.applique, borderDensity: v } }), 'ap.bd')} />
                      <Num label="Border pull comp (mm)" value={selected.applique.borderPullComp} step={0.05} min={0} max={1}
                        onChange={(v) => patch(selected.id, (o) => ({ ...o, applique: { ...o.applique, borderPullComp: v } }), 'ap.bp')} />
                    </>
                  )}
                </fieldset>
              )}

              {selected.type === 'fill' && (
                <>
                  <fieldset>
                    <legend>Fill</legend>
                    <div className="row">
                      <label>Style</label>
                      <select value={selected.fill.style}
                        onChange={(e) => {
                          // Spacing and length mean something different in
                          // each style, so they are re-based rather than
                          // carried across. See FILL_STYLE_DEFAULTS.
                          const style = e.target.value as FillStyle
                          const d = FILL_STYLE_DEFAULTS[style]
                          patch(selected.id, (o) => ({
                            ...o, fill: { ...o.fill, style, spacing: d.spacing, length: d.length },
                          }))
                        }}>
                        {FILL_STYLES.map((f) => (
                          <option key={f} value={f}>{FILL_STYLE_LABEL[f]}</option>
                        ))}
                      </select>
                    </div>
                    {/* Each style reads the shared controls differently, so
                        the labels say what the number means HERE rather than
                        leaving a generic name over a field that does
                        something else. */}
                    {selected.fill.style !== 'echo' && (
                      <Num label="Angle (°)" value={selected.fill.angle} step={5} min={-180} max={180}
                        onChange={(v) => patch(selected.id, (o) => ({ ...o, fill: { ...o.fill, angle: v } }), 'fill.angle')} />
                    )}
                    <Num
                      label={
                        selected.fill.style === 'stipple' ? 'Meander size (mm)'
                          : selected.fill.style === 'motif' ? 'Row gap (mm)'
                          : selected.fill.style === 'echo' ? 'Ring spacing (mm)'
                          : 'Stitch spacing (mm)'
                      }
                      value={selected.fill.spacing} step={0.05}
                      min={selected.fill.style === 'stipple' ? 1.5 : 0.15}
                      max={selected.fill.style === 'tatami' ? 2 : 12}
                      onChange={(v) => patch(selected.id, (o) => ({ ...o, fill: { ...o.fill, spacing: v } }), 'fill.spacing')} />
                    {selected.fill.style !== 'crossstitch' && (
                      <Num label="Stitch length (mm)" value={selected.fill.length} step={0.25} min={1} max={10}
                        onChange={(v) => patch(selected.id, (o) => ({ ...o, fill: { ...o.fill, length: v } }), 'fill.length')} />
                    )}
                    {selected.fill.style === 'crossstitch' && (
                      <Num label="Cross size (mm)" value={selected.fill.length} step={0.5} min={1} max={10}
                        onChange={(v) => patch(selected.id, (o) => ({ ...o, fill: { ...o.fill, length: v } }), 'fill.length')} />
                    )}
                    {selected.fill.style === 'tatami' && (
                      <>
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
                      </>
                    )}
                    {selected.fill.style !== 'tatami' && (
                      <div className="row wide">
                        <span className="dim">
                          {selected.fill.style === 'stipple'
                            ? 'A loose wandering line. Deliberately open — it softens a background without stiffening it. No underlay: it would show through the gaps.'
                            : selected.fill.style === 'crossstitch'
                            ? 'A grid of X’s, sewn only where a whole cross fits inside the shape. The fabric showing between them is the look.'
                            : selected.fill.style === 'echo'
                            ? 'Contours following the shape inwards, so the silhouette becomes the texture.'
                            : 'The motif below, stamped in rows. Only whole motifs are sewn.'}
                        </span>
                      </div>
                    )}
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
      </div>

      {/* The problems panel. Opens over the canvas rather than pushing it:
          you are reading it to decide what to do to the design, so the
          design has to stay visible. */}
      {showProblems && (
        <div className="probs-panel">
          <div className="probs-head">
            <b>{summary.actionable} to deal with</b>
            {summary.errors > 0 && (
              <span className="warn">{summary.errors} not stitching at all</span>
            )}
            <button className="link" onClick={() => setShowProblems(false)}>close</button>
          </div>
          {problems.filter((p) => p.severity !== 'note').map((p) => (
            <div key={p.id} className={`prob ${p.severity}`}>
              <span className="prob-mark">{p.severity === 'error' ? '✕' : '⚠'}</span>
              <div className="prob-body">
                {p.objectName && (
                  <button className="prob-obj" title="Show it on the canvas"
                    onClick={() => showProblemObject(p)}>{p.objectName}</button>
                )}
                <span className="prob-text">{p.text}</span>
                {!!p.fixes.length && (
                  <div className="prob-fixes">
                    {p.fixes.includes('select') && (
                      <button onClick={() => showProblemObject(p)}>Show it</button>
                    )}
                    {p.fixes.includes('showDensity') && (
                      <button onClick={() => { setShowDensity(true); setShowProblems(false) }}>
                        Shade the dense areas
                      </button>
                    )}
                    {p.fixes.includes('overlap') && (
                      <button className="primary"
                        title="Knock each object back so nothing is sewn twice where they overlap"
                        onClick={() => { runRemoveOverlap(); setShowProblems(false) }}>
                        Remove the overlaps
                      </button>
                    )}
                    {p.fixes.includes('thread') && (
                      <button onClick={() => {
                        const b = blocks.find((q) => q.number > 0 && !q.thread)
                        if (b) {
                          setInspector('colour')
                          setPicking(b.objects[0].object.id)
                          setNewName(colourName(b.color))
                        }
                        setShowProblems(false)
                      }}>Set the threads</button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="status">
        {busy && <span className="busy">generating…</span>}
        {/* The facts an operator reads off the bottom of the screen, in the
            order they ask for them: will it fit, how big is the thing I
            have selected, how long will it run, and how many times do I
            re-thread. */}
        <span><b>Hoop</b> {doc.hoop.name} — {sizePair(doc.hoop.widthMm, doc.hoop.heightMm)}</span>
        {selBox && (
          <span>
            <b>Selected</b> {sizePair(selBox.maxX - selBox.minX, selBox.maxY - selBox.minY)}
          </span>
        )}
        {pb && (
          <span>
            <b>Design</b> {sizePair(pb.widthMm, pb.heightMm)}
          </span>
        )}
        <span><b>Stitches</b> {counts.stitches.toLocaleString()}</span>
        <span title="Needles on the machine / colour blocks in this design">
          <b>Ndls/Cols</b> {machine.needles}/{threads}
        </span>
        {doc.fabric && (
          /* Named down here because it changes what every colour on the
             canvas looks like, and invisible state that alters the whole
             preview is how someone approves the wrong thing. */
          <span title="Garment colour — View ▸ Garment colour">
            on <span className="fabchip" style={{ background: doc.fabric }} />
            {' '}{colourName(doc.fabric)}
          </span>
        )}
        {total > 0 && <span>~<b>{stats.minutes.toFixed(1)}</b> min</span>}
        <span className="dim">
          {counts.jumps} jumps · {stats.trims} trims · longest {longestStitch(plan).toFixed(1)} mm
        </span>
        {ms > 0 && <span className="dim">{ms.toFixed(0)} ms{inline ? ' inline' : ''}</span>}
        {note && <span className="note">{note}</span>}
        {/* The freeze banner. A stale plan is a DECISION the user has to
            make — the spec's requirement is that hand edits are never lost
            silently, so nothing resolves this on their behalf. */}
        {frozenState.kind === 'frozen' && (
          <span className="frozen">
            ✎ {frozenState.edits} manual stitch edit{frozenState.edits === 1 ? '' : 's'} — plan frozen{' '}
            <button className="link" onClick={() => {
              setDoc((d) => ({ ...d, frozen: undefined }))
              setPicked([])
              setNote('Manual edits discarded — the plan is generated again')
            }}>discard &amp; regenerate</button>
          </span>
        )}
        {frozenState.kind === 'stale' && (
          <span className="warn">
            ⚠ The design changed since your {frozenState.edits} manual stitch edit
            {frozenState.edits === 1 ? '' : 's'}. Those edits are still what will be exported.{' '}
            <button className="link" onClick={() => {
              setDoc((d) => ({ ...d, frozen: undefined }))
              setPicked([])
              setNote('Manual edits discarded — the plan now follows the design again')
            }}>discard edits &amp; regenerate</button>
            {' · '}
            <button className="link" onClick={() => {
              setDoc((d) => (d.frozen
                ? { ...d, frozen: { ...d.frozen, signature: sourceSig } } : d))
              setNote('Keeping your stitch edits — the design change was not applied')
            }}>keep my edits</button>
          </span>
        )}
        {!!summary.actionable && (
          <button
            className={`probs${summary.errors ? ' bad' : ''}${showProblems ? ' on' : ''}`}
            title={next
              ? `Worst first: ${next.objectName ? `${next.objectName} — ` : ''}${next.text}`
              : 'What is wrong with this design, and what to do about it'}
            onClick={() => setShowProblems((v) => !v)}
          >
            ⚠ {summary.actionable} {summary.actionable === 1 ? 'issue' : 'issues'}
            {summary.errors > 0 && <b> · {summary.errors} not stitching</b>}
            <span className="caret">{showProblems ? '▾' : '▸'}</span>
          </button>
        )}
        {!summary.actionable && total > 0 && <span className="ok">✓ no problems found</span>}

        <span className="sim">
          <button
            className={`play${playing ? ' on' : ''}`}
            disabled={!total}
            title={playing ? 'Pause' : 'Watch it sew, in order'}
            onClick={() => setPlaying((v) => !v)}
          >{playing ? '❚❚' : '▶'}</button>
          <select
            value={speed} disabled={!total}
            title="How fast, as a multiple of the machine's own speed"
            onChange={(e) => setSpeed(Number(e.target.value))}
          >
            {[1, 5, 20, 100, 400].map((k) => (
              <option key={k} value={k}>{k}×</option>
            ))}
          </select>
          <input
            type="range" min={0} max={total} value={sim ?? total}
            onChange={(e) => {
              // Taking hold of the slider takes over from the playback —
              // fighting an animation for the handle is maddening.
              setPlaying(false)
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
