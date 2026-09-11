'use client'

import { useEffect, useRef, type ReactNode } from 'react'

interface FocusHeadingOnMountProps {
  /** Only actually steals focus when true. Kept a prop rather than an
   *  implicit "always focus on mount" so a caller rendered from a Server
   *  Component's initial page load (nothing has "changed" yet — stealing
   *  focus there would be wrong) can opt out, while a client-side result
   *  swap opts in. See `NonPayableScreen`'s own `autoFocus` doc comment. */
  active: boolean
  /** Which heading tag to render — the ref-bearing element is rendered here
   *  directly (never via `cloneElement`, which `eslint-plugin-react-hooks`'
   *  `refs` rule now flags as reading a ref's value during render). */
  as: 'h1' | 'h2'
  className?: string
  children: ReactNode
}

/**
 * The one client-only sliver a heading-focus-on-transition screen needs.
 * `useRef`/`useEffect` cannot run in a Server Component at all — isolating
 * them here is what lets a component like `NonPayableScreen` stay a plain
 * Server Component (imported directly into `page.tsx`'s tree with zero
 * client JS for every visitor who lands on a non-payable link, never
 * touching `PayForm`) while still supporting the one client-side transition
 * (`PayForm`'s `link_not_payable` swap) that does need to move focus.
 */
export function FocusHeadingOnMount({ active, as: Heading, className, children }: FocusHeadingOnMountProps) {
  const ref = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (active) ref.current?.focus()
  }, [active])

  return (
    <Heading ref={ref} tabIndex={-1} className={className}>
      {children}
    </Heading>
  )
}
