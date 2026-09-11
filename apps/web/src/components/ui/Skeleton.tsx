import { cn } from './cn'

interface SkeletonBaseProps {
  className?: string
  'aria-label'?: string
}

export type SkeletonProps =
  | ({ shape: 'block'; width?: string; height?: string } & SkeletonBaseProps)
  | ({ shape: 'line'; width?: string } & SkeletonBaseProps)
  | ({ shape: 'table-row'; columns: number } & SkeletonBaseProps)

const SHIMMER = 'motion-safe:animate-pulse rounded bg-(--color-border-soft)'

/**
 * Loading is a skeleton shaped like the content it stands in for, never a
 * centred spinner (§11's non-negotiable). `motion-safe:animate-pulse`, not a
 * bare `animate-pulse` — a `prefers-reduced-motion` visitor gets a still
 * placeholder instead of a pulsing one, satisfying that rule with no extra
 * media query of our own.
 *
 * Non-interactive: nothing here is a control, so the only state that applies
 * is "loading" itself — `role="status"` + `aria-busy` carry that to
 * assistive tech. There is no hover/focus/active/disabled/error variant of a
 * placeholder.
 */
export function Skeleton(props: SkeletonProps) {
  if (props.shape === 'table-row') {
    // Decorative filler inside a `<table>`; the live `aria-busy` announcement
    // belongs to Table, which owns the `<tbody>` these rows sit in.
    return (
      <tr aria-hidden="true" className={props.className}>
        {Array.from({ length: props.columns }, (_unused, index) => (
          <td key={index} className="px-4 py-3">
            <div className={cn(SHIMMER, 'h-4 w-full')} />
          </td>
        ))}
      </tr>
    )
  }

  if (props.shape === 'line') {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={props['aria-label'] ?? 'Loading…'}
        className={cn(SHIMMER, 'h-4', props.className)}
        style={{ width: props.width ?? '100%' }}
      />
    )
  }

  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={props['aria-label'] ?? 'Loading…'}
      className={cn(SHIMMER, props.className)}
      style={{ width: props.width ?? '100%', height: props.height ?? '2rem' }}
    />
  )
}
