import type { ReactNode } from 'react'
import { SpinnerIcon } from './icons'

/**
 * The checkout's one primary action, built as a single `state` enum rather
 * than a pile of booleans (`composition-patterns`'
 * `architecture-avoid-boolean-props`) — `loading` is not an independent axis
 * from the rest here, so `isLoading` + other flags would only invite an
 * impossible combination. `hover`/`focus`/`active` are not props at all:
 * they are Tailwind pseudo-classes layered onto `default`, exactly like every
 * other seven-state component in this design system is supposed to work.
 *
 * No `'disabled'` state: nothing in this PR ever renders the Pay button
 * disabled-but-idle — the form allows a submit attempt and reports
 * validation errors beside the fields instead of pre-disabling the button
 * (see `PayForm`'s own `validate()`), and `loading` already covers "not
 * clickable right now" for the one time this button truly cannot be pressed.
 * A `state` this component never receives is dead code, not a real seventh
 * state; if a caller needs a genuinely disabled-but-idle Pay button, add it
 * back with that caller in hand instead of speculatively.
 *
 * F1's UI kit will eventually own a general-purpose `Button`; this one stays
 * local to `checkout/` (per F6's brief) and swaps out then.
 */
export type PayButtonState = 'default' | 'loading' | 'error' | 'warning'

interface PayButtonProps {
  state: PayButtonState
  type?: 'submit' | 'button'
  onClick?: () => void
  loadingLabel?: string
  children: ReactNode
}

const BASE =
  'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-(--radius-input) px-5 text-[14px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-brand) disabled:cursor-not-allowed'

const VARIANT: Record<PayButtonState, string> = {
  default: 'bg-(--color-brand) text-white hover:bg-(--color-brand-hover) active:bg-(--color-brand-hover)',
  loading: 'bg-(--color-brand) text-white cursor-wait',
  error:
    'bg-(--color-danger-tint) text-(--color-danger) border border-(--color-danger) hover:bg-(--color-danger) hover:text-white active:bg-(--color-danger) active:text-white',
  // For a next step that follows a warning-amber banner (`PriceChangedResult`,
  // `TransportResult`) — `error` there read as "something worse than the copy
  // above it actually said," because a red button next to an amber "money
  // may or may not have moved" banner implies a harder failure than is
  // known. Reserved for screens whose icon/banner are themselves amber.
  warning:
    'bg-(--color-warning-tint) text-(--color-warning) border border-(--color-warning) hover:bg-(--color-warning) hover:text-white active:bg-(--color-warning) active:text-white',
}

export function PayButton({ state, type = 'submit', onClick, loadingLabel, children }: PayButtonProps) {
  const isDisabled = state === 'loading'
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={isDisabled}
      aria-busy={state === 'loading'}
      className={`${BASE} ${VARIANT[state]}`}
    >
      {state === 'loading' ? <SpinnerIcon /> : null}
      {state === 'loading' && loadingLabel ? loadingLabel : children}
    </button>
  )
}
