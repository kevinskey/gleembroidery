// A toolbar menu.
//
// The toolbar had grown to seven rows of buttons and was taking half the
// window — on a 900 px-tall laptop that left the canvas shorter than the
// panels beside it. Almost all of those buttons are things you press once
// and then forget about for an hour (export a file, unite two shapes, align
// a row), which is exactly what a menu is for; the handful you press
// constantly are the drawing tools, and those stay out as a palette.
//
// Behaves like a menu bar rather than like seven popovers that happen to sit
// next to each other: only one is open at a time, and once one IS open,
// moving across the others opens them in turn. That is the behaviour people
// already have in their hands, and getting it wrong is more annoying than
// not having menus at all.
//
// Coordination between menus goes through a DOM event rather than a shared
// React context: the menus are siblings in one toolbar with nothing else to
// say to each other, and a context would mean a provider wrapping the whole
// application to carry one string.

import {
  useCallback, useEffect, useId, useRef, useState, type ReactNode,
} from 'react'

const OPEN_EVENT = 'gw-menu-open'
const CLOSE_EVENT = 'gw-menu-close'

/** Is any menu currently open? Drives hover-to-switch. */
let anyOpen = false

export function closeAllMenus(): void {
  anyOpen = false
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: '' }))
}

export function Menu({
  label, title, children, width,
}: {
  label: ReactNode
  title?: string
  children: ReactNode
  /** Minimum panel width, px. Wider for menus with long item labels. */
  width?: number
}): ReactNode {
  const id = useId()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  /**
   * This menu was opened by sliding onto it, not by a click.
   *
   * Without this, moving across the bar to a menu opened it on enter and the
   * click that followed toggled it straight shut again — the menu appeared
   * and vanished under the pointer, which looked like it was broken.
   */
  const byHover = useRef(false)

  const close = useCallback(() => {
    setOpen(false)
    anyOpen = false
    byHover.current = false
  }, [])

  const show = useCallback(() => {
    setOpen(true)
    anyOpen = true
    // Tell the others to stand down. Dispatched rather than handled by a
    // parent so a menu can be dropped anywhere in the toolbar without
    // anything having to know it is there.
    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }))
  }, [id])

  useEffect(() => {
    const onOther = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) setOpen(false)
    }
    const onClose = () => setOpen(false)
    window.addEventListener(OPEN_EVENT, onOther)
    window.addEventListener(CLOSE_EVENT, onClose)
    return () => {
      window.removeEventListener(OPEN_EVENT, onOther)
      window.removeEventListener(CLOSE_EVENT, onClose)
    }
  }, [id])

  useEffect(() => {
    if (!open) return
    // Pointer DOWN, not click: a menu that closed on click would still be
    // open while the canvas underneath was already being dragged.
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  return (
    <div className="menu" ref={root}>
      <button
        className={`menu-btn${open ? ' on' : ''}`}
        title={title}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => {
          // A click that merely confirms what the hover already did leaves
          // the menu open; only a click on a menu the user opened
          // deliberately closes it again.
          if (byHover.current) { byHover.current = false; return }
          if (open) close(); else show()
        }}
        // Once one menu is open, sliding across the bar opens the others.
        onPointerEnter={() => {
          if (anyOpen && !open) { byHover.current = true; show() }
        }}
      >
        {label}<span className="caret">▾</span>
      </button>
      {open && (
        <div
          className="menu-panel"
          role="menu"
          style={width ? { minWidth: width } : undefined}
          // Anything inside that does something closes the menu, so a menu
          // item does not have to remember to. Checkboxes and number fields
          // opt out with .keep-open, since you usually want several.
          onClick={(e) => {
            const t = e.target as HTMLElement
            if (t.closest('.keep-open')) return
            if (t.closest('button, label.filepick')) close()
          }}
        >
          {children}
        </div>
      )}
    </div>
  )
}

/** A heading inside a menu, for grouping items that belong together. */
export function MenuLabel({ children }: { children: ReactNode }): ReactNode {
  return <div className="menu-label">{children}</div>
}

export function MenuSep(): ReactNode {
  return <div className="menu-sep" />
}

/**
 * A menu item.
 *
 * `hint` is shown under the label rather than only as a tooltip. These are
 * operations whose names cannot carry their meaning — "No overlap" and
 * "Exclude" are not self-explanatory to anyone who has not used them — and a
 * tooltip is no help to someone scanning a list for the thing they want.
 */
export function MenuItem({
  children, hint, disabled, title, onClick, active,
}: {
  children: ReactNode
  hint?: string
  disabled?: boolean
  title?: string
  active?: boolean
  onClick?: () => void
}): ReactNode {
  return (
    <button
      className={`menu-item${active ? ' on' : ''}`}
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <span className="mi-label">{children}</span>
      {hint && <span className="mi-hint">{hint}</span>}
    </button>
  )
}
