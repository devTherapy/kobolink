import { cn } from './cn'

interface SkeletonBaseProps {
  className?: string
  'aria-label'?: string
}

export type SkeletonProps =
  | ({ shape: 'block'; width?: string; height?: string } & SkeletonBaseProps)
  | ({ shape: 'line'; width?: string } & SkeletonBaseProps)
  | ({ shape: 'table-row'; columns: number } & SkeletonBaseProps)

// `--color-skeleton-fill` (not `--color-border-soft`, which is ~1.1:1 against
// white/ground and reads as invisible): calibrated to clear the 3:1 WCAG
// non-text-contrast floor on both surfaces (3.68:1 on white, 3.38:1 on
// `--color-ground`), so the shape is legible even with motion disabled.
const SHIMMER = 'motion-safe:animate-pulse rounded bg-(--color-skeleton-fill)'

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
            {/* Column 0 in every `Table` usage so far (`LinksTable`'s Link
                column) carries the row's title/description and is
                proportionally the widest — a `w-full` bar in every cell made
                the skeleton equal-width while the real content was not,
                producing a visible reflow the moment data replaced it.
                A narrower bar in every other column approximates that shape
                without `Skeleton` needing to know each column's real width. */}
            <div className={cn(SHIMMER, 'h-4', index === 0 ? 'w-3/4' : 'w-1/2')} />
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
