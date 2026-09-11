import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from './cn'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

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

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Defaults to `'idle'`. See the type doc above for why this isn't two booleans. */
  status?: ButtonStatus
  children: ReactNode
}

/**
 * Seven states, all CSS-driven off real DOM/ARIA rather than extra props:
 * default (base classes) · hover (`hover:`) · focus (`focus-visible:`,
 * matches the global ring token) · active (`active:`) · disabled (native
 * `disabled` attribute — blocks clicks and assistive tech for free) ·
 * loading (`status="loading"` → `aria-busy`, `data-loading`, inert) · error
 * (`status="error"` → `data-error`, a danger-toned ring the caller clears on
 * the next attempt).
 */
export function Button({
  variant = 'primary',
  size = 'md',
  status = 'idle',
  type = 'button',
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  const isLoading = status === 'loading'
  const isError = status === 'error'
  const isDisabled = disabled === true || isLoading

  return (
    <button
      type={type}
      disabled={isDisabled}
      aria-busy={isLoading || undefined}
      data-loading={isLoading || undefined}
      data-error={isError || undefined}
      className={cn(
        'relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-(--radius-input) border font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-brand)',
        'disabled:pointer-events-none disabled:opacity-50',
        isError && 'ring-2 ring-(--color-danger) ring-offset-2 ring-offset-(--color-ground)',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    >
      {/* The label stays in the layout (just hidden) while loading, so the
          button doesn't change width when the spinner appears. */}
      <span className={cn('inline-flex items-center gap-2', isLoading && 'invisible')}>{children}</span>
      {isLoading ? (
        <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
          <Spinner />
        </span>
      ) : null}
    </button>
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
