// Undo/redo over the document.
//
// Snapshot-based, not command-based: the document is a plain tree of objects
// and paths, every edit already produces a fresh one, and a snapshot stack is
// the version that cannot drift from the thing it is undoing. A command stack
// would need an inverse for each of the twenty-odd edits in App.tsx, and one
// wrong inverse corrupts a design silently. Memory is not the constraint — a
// busy document is a few hundred kilobytes and the stack is capped.
//
// The hard part is not the stack, it is DECIDING WHAT COUNTS AS ONE STEP:
//
//   * a move or resize drag calls set() on every mousemove. Without grouping,
//     one drag buries the user's real history under hundreds of entries and
//     undo becomes a frame-by-frame rewind of a gesture they already finished.
//     Gestures are bracketed explicitly: begin() marks the next set() as the
//     one that records, and everything until end() amends it in place.
//   * typing in a number field, or dragging a slider, fires a change per
//     keystroke. Those coalesce by TAG within a short window: consecutive
//     edits carrying the same tag amend the entry they already made.
//
// Pure except for React state, so the reducer below is covered headlessly.

import { useCallback, useMemo, useRef, useState } from 'react'

/** How many steps back the stack keeps. */
export const HISTORY_LIMIT = 60

/** Same-tag edits closer together than this merge into one step, ms. */
export const COALESCE_MS = 700

export interface HistoryState<T> {
  past: T[]
  present: T
  future: T[]
  /** Tag and timestamp of the entry on top, for coalescing. */
  tag: string | null
  at: number
}

export function initHistory<T>(present: T): HistoryState<T> {
  return { past: [], present, future: [], tag: null, at: 0 }
}

export type Mode =
  /** Normal edit: pushes a new undo step. */
  | { kind: 'record'; tag?: string; now?: number }
  /** Part of a gesture already recorded: replaces the present, no new step. */
  | { kind: 'amend' }
  /** New document: the stack is meaningless, so it is dropped. */
  | { kind: 'reset' }

export function applyEdit<T>(s: HistoryState<T>, next: T, mode: Mode): HistoryState<T> {
  if (mode.kind === 'reset') return initHistory(next)
  if (mode.kind === 'amend') return { ...s, present: next }

  const now = mode.now ?? 0
  const tag = mode.tag ?? null
  // Coalesce: the previous step carried the same tag and was a moment ago, so
  // this is the same user action continuing (a slider still moving, a number
  // still being typed) rather than a new one.
  const merge = tag !== null && s.tag === tag && now - s.at < COALESCE_MS && s.past.length > 0
  if (merge) return { ...s, present: next, at: now, future: [] }

  const past = [...s.past, s.present]
  // Drop the oldest when full. The alternative — refusing new steps — would
  // silently stop recording the edits the user is making right now.
  if (past.length > HISTORY_LIMIT) past.shift()
  return { past, present: next, future: [], tag, at: now }
}

/**
 * Throw away a gesture that was recorded but is being abandoned (Escape
 * mid-drag). Distinct from undo: the cancelled drag must NOT become redoable,
 * because the user said they did not want it.
 */
export function cancelState<T>(s: HistoryState<T>): HistoryState<T> {
  if (s.past.length === 0) return s
  const past = [...s.past]
  const present = past.pop()!
  return { past, present, future: s.future, tag: null, at: 0 }
}

export function undoState<T>(s: HistoryState<T>): HistoryState<T> {
  if (s.past.length === 0) return s
  const past = [...s.past]
  const present = past.pop()!
  // Undoing clears the coalescing tag: the next edit must start a fresh step,
  // not merge into the one we just stepped off.
  return { past, present, future: [s.present, ...s.future], tag: null, at: 0 }
}

export function redoState<T>(s: HistoryState<T>): HistoryState<T> {
  if (s.future.length === 0) return s
  const [present, ...future] = s.future
  return { past: [...s.past, s.present], present, future, tag: null, at: 0 }
}

export interface History<T> {
  state: T
  /** Edit the document. `tag` enables coalescing with the previous edit. */
  set: (updater: (prev: T) => T, tag?: string) => void
  /** Replace the document and drop the stack — opening a different project. */
  reset: (value: T) => void
  /** Bracket a drag so the whole gesture is ONE undo step. */
  begin: () => void
  end: () => void
  /** Abandon the gesture in flight, restoring the document before it. */
  cancel: () => void
  undo: () => void
  redo: () => void
  /** The whole stack, for parking a document while another is on screen. */
  snapshot: () => HistoryState<T>
  /** Put a parked stack back, undo history and all. */
  install: (next: HistoryState<T>) => void
  canUndo: boolean
  canRedo: boolean
}

export function useHistory<T>(initial: T | (() => T)): History<T> {
  const [h, setH] = useState<HistoryState<T>>(() =>
    initHistory(typeof initial === 'function' ? (initial as () => T)() : initial))
  // 'pending' = the next set() opens the gesture; 'active' = amend into it.
  const gesture = useRef<false | 'pending' | 'active'>(false)

  const set = useCallback((updater: (prev: T) => T, tag?: string) => {
    setH((s) => {
      const next = updater(s.present)
      if (next === s.present) return s
      if (gesture.current === 'active') return applyEdit(s, next, { kind: 'amend' })
      if (gesture.current === 'pending') {
        gesture.current = 'active'
        return applyEdit(s, next, { kind: 'record', now: Date.now() })
      }
      return applyEdit(s, next, { kind: 'record', tag, now: Date.now() })
    })
  }, [])

  const reset = useCallback((value: T) => {
    gesture.current = false
    setH((s) => applyEdit(s, value, { kind: 'reset' }))
  }, [])

  const begin = useCallback(() => { gesture.current = 'pending' }, [])
  const end = useCallback(() => { gesture.current = false }, [])
  const cancel = useCallback(() => {
    // Only 'active' put a step on the stack; 'pending' means the gesture never
    // moved, so there is nothing to take back.
    const had = gesture.current === 'active'
    gesture.current = false
    if (had) setH(cancelState)
  }, [])
  const undo = useCallback(() => { gesture.current = false; setH(undoState) }, [])
  const redo = useCallback(() => { gesture.current = false; setH(redoState) }, [])

  /**
   * The whole stack, for parking a document while another is on screen.
   *
   * Switching between open documents has to keep each one's undo stack, or
   * every switch silently throws away the work you could take back. The
   * stack is plain data, so the tab strip parks it and hands it back.
   */
  const snapshot = useCallback(() => h, [h])
  const install = useCallback((next: HistoryState<T>) => {
    gesture.current = false
    setH(next)
  }, [])

  return useMemo(() => ({
    state: h.present, set, reset, begin, end, cancel, undo, redo, snapshot, install,
    canUndo: h.past.length > 0, canRedo: h.future.length > 0,
  }), [h, set, reset, begin, end, cancel, undo, redo, snapshot, install])
}
