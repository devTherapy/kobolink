import type { ReactNode } from 'react'
import type { displayStatus } from '@kobolink/contracts'
import { cn } from './cn'

export type PillTone = 'success' | 'warning' | 'danger' | 'neutral'
/**
 * The four link statuses (`Active`/`Disabled`/`Expired`/`Paid`) are derived
 * from contracts' `displayStatus` return type, not retyped here — a status
 * `displayStatus` stops returning (or a new one it starts returning) is then
 * a type error at this line, not a badge silently missing its tone.
 * `Pending`/`Failed` are payment-row statuses with no Title-Case contracts
 * export to derive from (`PaymentStatus` is the lowercase wire enum used for
 * the API, a different shape for a different purpose); they stay
 * `Pill`-owned until a display-status helper exists for payments too.
 */
export type PillStatus = ReturnType<typeof displayStatus> | 'Pending' | 'Failed'

const TONE_CLASSES: Record<PillTone, string> = {
  success: 'bg-(--color-success-tint) text-(--color-success)',
  warning: 'bg-(--color-warning-tint) text-(--color-warning)',
  danger: 'bg-(--color-danger-tint) text-(--color-danger)',
  // No dedicated "neutral" tint token exists; --color-border-soft / --color-ink-2
  // already clear 4.5:1 together (6.38:1) and read as unmistakably muted next
  // to the tinted tones above, without minting a new colour for one badge.
  neutral: 'bg-(--color-border-soft) text-(--color-ink-2)',
}

/**
 * The tone each named status reads as at a glance. Green agrees with "money
 * is fine or on its way" (Active, Paid), amber flags something mid-flight
 * (Pending), red flags something that failed (Failed). Disabled and Expired
 * are deliberately grey, not amber or red: a link that's off or timed out
 * isn't a failure, it just isn't live right now.
 */
const STATUS_TONE: Record<PillStatus, PillTone> = {
  Active: 'success',
  Paid: 'success',
  Pending: 'warning',
  Failed: 'danger',
  Disabled: 'neutral',
  Expired: 'neutral',
}

export interface PillProps {
  tone: PillTone
  children: ReactNode
  className?: string | undefined
}

/**
 * Non-interactive: a Pill is a badge, not a control. It ships only the one
 * state that applies to it — its tone-based appearance — and none of hover,
 * focus, active, disabled, loading or error, because nothing can click, tab
 * to, or submit a badge.
 */
export function Pill({ tone, children, className }: PillProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium leading-5',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

/** Convenience wrapper over the six statuses named in `PLAN.md` §4. */
export function StatusPill({ status, className }: { status: PillStatus; className?: string | undefined }) {
  return (
    <Pill tone={STATUS_TONE[status]} className={className}>
      {status}
    </Pill>
  )
}
