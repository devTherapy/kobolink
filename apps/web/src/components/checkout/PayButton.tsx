import type { ReactNode } from 'react'
import { SpinnerIcon } from './icons'

/**
 * The checkout's one primary action, built as a single `state` enum rather
 * than a pile of booleans (`composition-patterns`'
 * `architecture-avoid-boolean-props`) — `loading` and `disabled` are not
 * independent axes here, so `isLoading` + `isDisabled` would only invite an
 * impossible combination. `hover`/`focus`/`active` are not props at all:
 * they are Tailwind pseudo-classes layered onto `default`, exactly like every
 * other seven-state component in this design system is supposed to work.
 *
 * F1's UI kit will eventually own a general-purpose `Button`; this one stays
 * local to `checkout/` (per F6's brief) and swaps out then.
 */
export type PayButtonState = 'default' | 'loading' | 'disabled' | 'error'

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
  disabled: 'bg-(--color-border-soft) text-(--color-ink-2)',
  error:
    'bg-(--color-danger-tint) text-(--color-danger) border border-(--color-danger) hover:bg-(--color-danger) hover:text-white active:bg-(--color-danger) active:text-white',
}

export function PayButton({ state, type = 'submit', onClick, loadingLabel, children }: PayButtonProps) {
  const isDisabled = state === 'disabled' || state === 'loading'
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
