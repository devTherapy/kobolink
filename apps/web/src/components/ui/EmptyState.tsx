import type { ReactNode } from 'react'
import { cn } from './cn'

export interface EmptyStateProps {
  icon?: ReactNode
  title: string
  body?: ReactNode
  /**
   * A ready node — typically a `<Button>` — not an `actionLabel`/`onAction`
   * pair. Composing the finished element in (`patterns-children-over-render-props`)
   * means EmptyState never has to know or forward the action's variant,
   * loading, or error state; the caller owns that entirely.
   */
  action?: ReactNode
  className?: string
}

/**
 * Teaches the interface rather than reporting absence (§11 non-negotiable):
 * every empty state names what's missing and offers the next step.
 *
 * Non-interactive itself — no hover/focus/active/disabled/loading/error of
 * its own. Whatever is passed as `action` (a Button) carries its own full
 * seven-state set independently of this wrapper.
 */
export function EmptyState({ icon, title, body, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-6 py-12 text-center', className)}>
      {icon ? (
        // Neutral, not brand-tinted: the accent is spent on primary actions,
        // selection and focus only, never decoration (§11 non-negotiable) —
        // and a decorative icon badge is exactly decoration. Same neutral
        // pairing Pill's "neutral" tone uses.
        <div
          aria-hidden="true"
          className="flex h-12 w-12 items-center justify-center rounded-full bg-(--color-border-soft) text-(--color-ink-2)"
        >
          {icon}
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <h3 className="text-[16px] font-semibold text-(--color-ink)">{title}</h3>
        {body ? <p className="max-w-sm text-[14px] text-(--color-ink-2)">{body}</p> : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}
