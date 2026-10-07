'use client'

import type { ReactNode, SVGProps } from 'react'
import type { StreamStatus } from '@/lib/dashboard-stream'
import { cn } from '@/components/ui/cn'
import { useDashboardStream } from './DashboardStreamProvider'

interface StatusView {
  label: string
  /** What it means for the figures on the page — said in words, not left to a colour. */
  detail: string
  icon: ReactNode
}

const VIEWS: Record<StreamStatus, StatusView> = {
  live: {
    label: 'Live',
    detail: 'Figures update as payments arrive.',
    icon: <LiveIcon />,
  },
  connecting: {
    label: 'Connecting…',
    detail: 'Connecting for live updates.',
    icon: <BusyIcon />,
  },
  reconnecting: {
    label: 'Reconnecting…',
    detail: 'Updates paused. Figures may be out of date.',
    icon: <BusyIcon />,
  },
  offline: {
    label: 'Offline',
    detail: 'No connection. Figures may be out of date.',
    icon: <OfflineIcon />,
  },
}

/**
 * The honest connection state of the live dashboard (PLAN.md F7): live,
 * connecting, reconnecting or offline. Mounted in the dashboard header, so it
 * is on every screen whose figures it describes.
 *
 * Three rules from the design system apply to something this small:
 *
 * - **Not colour-only, and not payment colours.** Green, amber and red mean
 *   payment states; a "live" dot in green would read as "paid". The state is a
 *   word and a *shape* (filled dot / spinning ring / slashed circle), all in
 *   ink. The accent is for actions and focus, so it is not spent here either.
 * - **Said to a screen reader too.** A polite `role="status"`, so a change from
 *   live to reconnecting is announced once, with what it means for the numbers.
 *   The sentence is visible from `md` up whenever the stream is *not* live — a
 *   warning belongs on screen — and screen-reader-only on a phone, where the
 *   header has no room for it, and while everything is fine.
 * - **Motion only if asked for.** The ring turns under `motion-safe`.
 *
 * Display only: nothing to press, so no hover/focus/active/disabled states to
 * ship — the same position `Pill` and `Card` take.
 */
export function ConnectionStatus({ className }: { className?: string }) {
  const { status } = useDashboardStream()
  const view = VIEWS[status]

  return (
    <p
      role="status"
      data-status={status}
      className={cn('inline-flex min-w-0 items-center gap-1.5 text-[13px] text-(--color-ink-2)', className)}
    >
      {view.icon}
      <span className="font-medium text-(--color-ink)">{view.label}</span>
      <span className={cn(status === 'live' ? 'sr-only' : 'sr-only md:not-sr-only md:max-w-[22rem] md:truncate')}>
        <span aria-hidden="true">— </span>
        {view.detail}
      </span>
    </p>
  )
}

function Icon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      className="shrink-0"
      {...props}
    />
  )
}

/** A solid dot: connected and receiving. */
function LiveIcon() {
  return (
    <Icon>
      <circle cx="8" cy="8" r="4" fill="currentColor" stroke="none" />
    </Icon>
  )
}

/** An open ring with a gap, turning: working on it. */
function BusyIcon() {
  return (
    <Icon className="shrink-0 motion-safe:animate-spin">
      <path d="M8 2a6 6 0 1 0 6 6" />
    </Icon>
  )
}

/** A circle struck through: no connection. */
function OfflineIcon() {
  return (
    <Icon>
      <circle cx="8" cy="8" r="6" />
      <path d="M3.8 12.2 12.2 3.8" />
    </Icon>
  )
}
