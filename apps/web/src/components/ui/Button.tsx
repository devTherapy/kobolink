'use client'

import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react'
import { useId } from 'react'
import { cn } from './cn'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'
/** Which page surface the button sits on, so the error ring's `ring-offset`
 * colour matches instead of always assuming `--color-ground`. A literal
 * union (not an arbitrary CSS-variable prop) because Tailwind's build-time
 * scanner needs the complete class name present in source — a class string
 * assembled at runtime from an interpolated variable never gets generated. */
export type ButtonSurface = 'ground' | 'surface'

/**
 * `loading` and `error` are mutually exclusive outcomes of the same async
 * action, not independent booleans — a button is never both mid-request and
 * showing last request's failure at once. Modelling that as one `status`
 * enum instead of two booleans (`loading`, `hasError`) is the
 * `composition-patterns` `patterns-explicit-variants` rule: a button can only
 * be in one of these at a time, so the type should say so.
 */
export type ButtonStatus = 'idle' | 'loading' | 'error'

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-(--color-brand) text-white hover:bg-(--color-brand-hover) active:brightness-90',
  secondary:
    'border-(--color-border) bg-(--color-surface) text-(--color-ink) hover:bg-(--color-border-soft) active:bg-(--color-border)',
  ghost: 'border-transparent bg-transparent text-(--color-brand) hover:bg-(--color-brand-tint) active:brightness-95',
  danger: 'border-transparent bg-(--color-danger) text-white hover:brightness-90 active:brightness-80',
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-11 px-3 text-[13px]',
  md: 'h-11 px-4 text-[14px]',
  lg: 'h-12 px-5 text-[16px]',
}

const RING_OFFSET_CLASSES: Record<ButtonSurface, string> = {
  ground: 'ring-offset-(--color-ground)',
  surface: 'ring-offset-(--color-surface)',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Defaults to `'idle'`. See the type doc above for why this isn't two booleans. */
  status?: ButtonStatus
  /** Defaults to `'ground'`. Set to `'surface'` for a button on a white card/panel. */
  surface?: ButtonSurface
  /**
   * What failed, announced via `aria-describedby` — `status="error"` is
   * otherwise a colour-only ring, invisible to a screen reader. Defaults to
   * a generic message so the error state is never silent even if the caller
   * doesn't pass one; passing a specific one (e.g. "Payment failed — no
   * charge was made") is strongly preferred.
   */
  errorMessage?: string
  children: ReactNode
}

/**
 * `'use client'` because the loading-click-guard (`handleClick`, below)
 * always attaches a real `onClick` to the underlying `<button>`, regardless
 * of whether the caller passed one — and a plain function component
 * rendered directly by a Server Component (the kit showcase does this at
 * module scope) can't hand an event handler prop to a host element. This
 * broke `next build`'s prerender of `/kit` before the directive was added:
 * "Event handlers cannot be passed to Client Component props". Server
 * Components rendering `<Button>` directly (as `/kit` does) is still fine —
 * that's the standard "client leaf inside a server tree" shape; only a
 * Server Component *defining* its own handler is disallowed.
 *
 * Seven states, all CSS-driven off real DOM/ARIA rather than extra props:
 * default (base classes) · hover (`hover:`) · focus (`focus-visible:`,
 * matches the global ring token) · active (`active:`) · disabled (native
 * `disabled` attribute — blocks clicks and assistive tech for free) ·
 * loading (`aria-disabled` + `aria-busy`, NOT native `disabled` — a natively
 * disabled element can't hold focus, so a button disabled out from under a
 * mid-click keyboard user drops focus to `<body>`; clicks are blocked by a
 * JS guard instead, and the button stays real, focusable, and Tab-reachable)
 * · error (`status="error"` → `data-error`, a danger-toned ring PLUS
 * `aria-describedby` naming what failed — a ring alone conveys nothing to
 * assistive tech or a colour-blind user).
 */
export function Button({
  variant = 'primary',
  size = 'md',
  status = 'idle',
  surface = 'ground',
  type = 'button',
  disabled,
  errorMessage,
  className,
  children,
  onClick,
  ...rest
}: ButtonProps) {
  const isLoading = status === 'loading'
  const isError = status === 'error'
  const errorId = useId()

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    if (isLoading) {
      event.preventDefault()
      return
    }
    onClick?.(event)
  }

  return (
    <>
      <button
        type={type}
        disabled={disabled}
        aria-disabled={isLoading || undefined}
        aria-busy={isLoading || undefined}
        aria-describedby={isError ? errorId : undefined}
        data-loading={isLoading || undefined}
        data-error={isError || undefined}
        onClick={handleClick}
        className={cn(
          'relative inline-flex touch-manipulation select-none items-center justify-center gap-2 whitespace-nowrap rounded-(--radius-input) border font-medium transition-colors',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-brand)',
          'disabled:pointer-events-none disabled:opacity-50',
          // Not `cursor-wait`: `pointer-events-none` makes the element
          // unreachable to the mouse in the first place, so no cursor style
          // set on it is ever actually shown — dead CSS.
          isLoading && 'pointer-events-none',
          isError && cn('ring-2 ring-(--color-danger) ring-offset-2', RING_OFFSET_CLASSES[surface]),
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          className,
        )}
        {...rest}
      >
        {/* The label stays in the layout and in the accessibility tree while
            loading — `opacity-0`, not `invisible` (`visibility:hidden`),
            which would drop it, and the button's own accessible name,
            entirely. Only its *visual* presence is hidden, so the button
            doesn't change width when the spinner appears. */}
        <span className={cn('inline-flex items-center gap-2', isLoading && 'opacity-0')}>{children}</span>
        {isLoading ? (
          <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
            <Spinner />
          </span>
        ) : null}
      </button>
      {/* Rendered as the button's *sibling*, not its child: a `sr-only`
          element is still in the accessibility tree (unlike `aria-hidden`),
          so nesting it inside the button would merge its text into the
          button's accessible NAME ("RetryPayment failed…"), not just its
          description. `aria-describedby` can point anywhere in the
          document, so this stays out of the name computation entirely. */}
      {isError ? (
        <span id={errorId} className="sr-only">
          {errorMessage ?? 'This action failed. Try again.'}
        </span>
      ) : null}
    </>
  )
}

function Spinner() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 motion-safe:animate-spin"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}
