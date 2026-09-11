import type { ReactNode } from 'react'
import { cn } from './cn'

export interface CardProps {
  children: ReactNode
  className?: string
  /** Semantic wrapper tag. Defaults to a plain grouping `div`. */
  as?: 'div' | 'article' | 'section'
  /** `'none'` for a Card wrapping something that manages its own padding, e.g. a Table. */
  padding?: 'none' | 'md'
}

/**
 * Non-interactive: a Card is a surface, not a control. It ships only the one
 * state that applies to it — the bordered/shadowed surface treatment — and
 * none of hover, focus, active, disabled, loading or error of its own.
 * Anything clickable inside a Card (a Button, a link) carries its own full
 * seven-state set; the Card around it does not gain states by association.
 */
export function Card({ children, className, as: Tag = 'div', padding = 'md' }: CardProps) {
  return (
    <Tag
      className={cn(
        'rounded-(--radius-card) border border-(--color-border) bg-(--color-surface) shadow-(--shadow-card)',
        padding === 'md' && 'p-4',
        className,
      )}
    >
      {children}
    </Tag>
  )
}
