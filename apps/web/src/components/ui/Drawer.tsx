'use client'

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './Button'

export interface DrawerProps {
  open: boolean
  /**
   * Called for Esc and the Close button. The Drawer never closes itself: the
   * owner decides, so a form with a request in flight can refuse to be
   * dismissed out from under the result it is waiting for.
   */
  onClose: () => void
  title: string
  /**
   * Where focus returns when the drawer closes — the control that opened it.
   * Passed explicitly because Safari does not focus a `<button>` on click, so
   * "whatever was focused when it opened" can be `<body>` there. Falls back to
   * that recorded element when omitted.
   */
  returnFocusRef?: RefObject<HTMLElement | null> | undefined
  children: ReactNode
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function tabbablesIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(TABBABLE))
}

/**
 * A modal side sheet: slides in from the right, full width below `sm`.
 *
 * Seven-state note: the Drawer is a container, not a control — it has no
 * hover/active/disabled/loading/error of its own. What it owns is the
 * modal contract, and each part of it is an explicit rule, not a hope:
 *
 *  - **Focus trap.** Tab and Shift+Tab wrap inside the panel; and everything
 *    else in `<body>` is made `inert` while it is open, so neither keyboard
 *    nor a screen reader's virtual cursor can wander back into the page
 *    underneath.
 *  - **Esc closes** (via `onClose`).
 *  - **Focus lands on content, not chrome:** on open, the first tabbable
 *    element of the *body* (the form's first field), falling back to the
 *    Close button only for a body with nothing focusable.
 *  - **Focus returns** to the opener on close.
 *  - **Scroll lock** on `<body>` while open, restored exactly.
 *
 * Deliberately no click-on-backdrop dismissal: this holds forms, and a stray
 * tap outside should not throw away what the merchant typed.
 *
 * The motion is `prefers-reduced-motion: no-preference` only (see
 * `globals.css`): a reduced-motion visitor gets the sheet already in place.
 */
export function Drawer({ open, onClose, title, returnFocusRef, children }: DrawerProps) {
  // `document` does not exist during SSR. The owner starts closed, so this
  // only matters for a drawer rendered open on the server — which would have
  // nowhere to portal to; render nothing rather than crash.
  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <DrawerPanel onClose={onClose} title={title} returnFocusRef={returnFocusRef}>
      {children}
    </DrawerPanel>,
    document.body,
  )
}

/**
 * Mounted only while open, so every effect below is bound to "the drawer is
 * showing" by React's own lifecycle — no `if (open)` guards to get wrong, and
 * cleanup is exactly the close.
 */
function DrawerPanel({
  onClose,
  title,
  returnFocusRef,
  children,
}: Pick<DrawerProps, 'onClose' | 'title' | 'returnFocusRef' | 'children'>) {
  const titleId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // The latest `onClose`, for a listener that must not be re-subscribed on
  // every render of the owner (`advanced-use-latest`).
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  // Esc is listened for on `document`, not on the panel: a form that disables
  // its inputs while submitting drops focus to `<body>` (a disabled element
  // cannot hold it), and a panel-level handler would then never hear Esc.
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') onCloseRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  useEffect(() => {
    const root = rootRef.current
    const panel = panelRef.current
    const body = bodyRef.current
    if (!root || !panel || !body) return

    // Captured before focus moves, for the fallback described on `returnFocusRef`.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const inerted: { element: HTMLElement; was: boolean }[] = []
    for (const sibling of Array.from(document.body.children)) {
      if (sibling === root || !(sibling instanceof HTMLElement)) continue
      inerted.push({ element: sibling, was: sibling.hasAttribute('inert') })
      sibling.setAttribute('inert', '')
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const initialFocus = tabbablesIn(body)[0] ?? tabbablesIn(panel)[0] ?? panel
    initialFocus.focus()

    return () => {
      for (const { element, was } of inerted) {
        if (!was) element.removeAttribute('inert')
      }
      document.body.style.overflow = previousOverflow
      // The opener's ref points at a node *this* component never renders and
      // that outlives it, so the lint rule's "may have changed by cleanup"
      // worry is exactly what is wanted here: the opener's value *now*.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const target = returnFocusRef?.current ?? opener
      if (target?.isConnected) target.focus()
    }
    // The ref object is stable; `returnFocusRef.current` is deliberately read
    // at cleanup time, not captured here.
  }, [returnFocusRef])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') return

    const panel = panelRef.current
    if (!panel) return
    const tabbables = tabbablesIn(panel)
    const first = tabbables[0]
    const last = tabbables[tabbables.length - 1]
    if (!first || !last) {
      event.preventDefault()
      panel.focus()
      return
    }

    const active = document.activeElement
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div ref={rootRef} className="fixed inset-0 z-50">
      <div aria-hidden="true" className="drawer-backdrop absolute inset-0 bg-(--color-panel)/50" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="drawer-panel absolute inset-y-0 right-0 flex w-full max-w-md flex-col bg-(--color-surface) shadow-(--shadow-float) focus:outline-none"
      >
        <header className="flex items-center justify-between gap-3 border-b border-(--color-border) px-4 py-3">
          <h2 id={titleId} className="text-[18px] font-semibold text-(--color-ink)">
            {title}
          </h2>
          <Button variant="ghost" size="sm" surface="surface" onClick={onClose}>
            Close
          </Button>
        </header>
        <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
          {children}
        </div>
      </div>
    </div>
  )
}
