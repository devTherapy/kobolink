'use client'

import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react'
import { cn } from './cn'

/**
 * Same reasoning as `Button`'s `ButtonStatus`: a switch mid-request and a
 * switch showing last request's failure are two outcomes of one async
 * action, never both at once — one enum, not two booleans.
 */
export type SwitchStatus = 'idle' | 'loading' | 'error'

export interface SwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role' | 'children' | 'type'> {
  /** What the switch is showing right now — for an optimistic switch, the value it is *about to* have. */
  checked: boolean
  /** Asked, not forced: the owner decides what `checked` becomes (so it can refuse, or roll back). */
  onCheckedChange: (next: boolean) => void
  /** The visible label, and the switch's accessible name. */
  children: ReactNode
  status?: SwitchStatus
}

/**
 * A labelled on/off switch: a real `<button role="switch" aria-checked>`, so
 * Space and Enter both toggle it and a screen reader says "on"/"off" rather
 * than "pressed". The label is inside the button, so the whole row is one
 * target (>= 44px tall) and the accessible name is the visible text.
 *
 * The accent is spent here on *selection* — the "on" track is `--color-brand`.
 * It is deliberately not green: green belongs to payment states, and a link
 * being "on" is not a payment succeeding.
 *
 * Seven states, all driven off real DOM/ARIA rather than extra props, the way
 * `Button` does it:
 *  - default — the track and thumb at rest, off or on;
 *  - hover — `hover:` darkens the track (and tints the row);
 *  - focus — `focus-visible:` ring on the button, matching the global token;
 *  - active — `active:` scales the thumb, a physical press;
 *  - disabled — native `disabled`: blocks clicks, dims, leaves the tab order;
 *  - loading — `status="loading"`: `aria-busy` + `aria-disabled` and a JS click
 *    guard, NOT native `disabled`, so a keyboard user's focus survives the
 *    request (a natively disabled button drops focus to `<body>`). The thumb
 *    pulses (still, under reduced motion);
 *  - error — `status="error"`: a danger ring plus `data-error`. The *message*
 *    is the owner's: render it as text next to the switch and point
 *    `aria-describedby` at it, so the failure is words, not just a colour.
 */
export function Switch({
  checked,
  onCheckedChange,
  children,
  status = 'idle',
  disabled,
  className,
  onClick,
  ...rest
}: SwitchProps) {
  const isLoading = status === 'loading'
  const isError = status === 'error'

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    if (isLoading) {
      event.preventDefault()
      return
    }
    onClick?.(event)
    if (!event.defaultPrevented) onCheckedChange(!checked)
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={isLoading || undefined}
      aria-busy={isLoading || undefined}
      disabled={disabled}
      data-loading={isLoading || undefined}
      data-error={isError || undefined}
      onClick={handleClick}
      className={cn(
        'group inline-flex min-h-11 touch-manipulation select-none items-center gap-3 rounded-(--radius-input) text-left text-[14px] font-medium text-(--color-ink)',
        'focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--color-brand)',
        // `pointer-events-none`, like `Button`: a natively disabled switch
        // takes no hover or press styling, and no click.
        'disabled:pointer-events-none disabled:opacity-50',
        !disabled && !isLoading && 'cursor-pointer',
        isLoading && 'cursor-progress',
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent transition-colors',
          checked
            ? 'bg-(--color-brand) group-hover:bg-(--color-brand-hover)'
            : 'bg-(--color-skeleton-fill) group-hover:brightness-90',
          isError && 'ring-2 ring-(--color-danger) ring-offset-2 ring-offset-(--color-surface)',
        )}
      >
        <span
          className={cn(
            'absolute left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-150 motion-reduce:transition-none',
            checked && 'translate-x-5',
            'group-active:scale-95',
            isLoading && 'motion-safe:animate-pulse opacity-80',
          )}
        />
      </span>
      <span>{children}</span>
    </button>
  )
}
