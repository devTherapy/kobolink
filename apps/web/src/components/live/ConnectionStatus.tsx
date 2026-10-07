'use client'

import type { ReactNode, SVGProps } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { StreamStatus } from '@/lib/dashboard-stream'
import { signInHref } from '@/lib/link-status'
import { sameOriginPath } from '@/lib/next-path'
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
  // Retrying cannot help either of these two, so neither says "reconnecting".
  'signed-out': {
    label: 'Signed out',
    detail: 'Your session has ended, so updates stopped. Figures may be out of date.',
    icon: <SignedOutIcon />,
  },
  stopped: {
    label: 'Updates stopped',
    detail: "This account can't receive live updates. Figures may be out of date.",
    icon: <StoppedIcon />,
  },
}

/**
 * The honest connection state of the live dashboard (PLAN.md F7): live,
 * connecting, reconnecting, offline — or one of the two states retrying cannot
 * cure: the session ended (`signed-out`, which offers sign-in back to this page)
 * and a non-merchant account (`stopped`, which offers nothing: signing in again
 * changes nothing for it). Mounted in the dashboard header, so it
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
 * Display only, except for the one link: the status itself has nothing to press,
 * so no hover/focus/active/disabled states of its own — the same position `Pill`
 * and `Card` take. The sign-in link sits *beside* the status region, not in it, so
 * the announcement is the sentence alone and the link is reached by tabbing; it
 * never takes focus. It is a plain link, so it has hover, focus and active states
 * and no disabled / loading / error ones (navigation has none to show).
 */
export function ConnectionStatus({ className }: { className?: string }) {
  const { status } = useDashboardStream()
  const view = VIEWS[status]

  return (
    <div className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      <p
        role="status"
        data-status={status}
        className="inline-flex min-w-0 items-center gap-1.5 text-[13px] text-(--color-ink-2)"
      >
        {view.icon}
        <span className="font-medium text-(--color-ink)">{view.label}</span>
        <span className={cn(status === 'live' ? 'sr-only' : 'sr-only md:not-sr-only md:max-w-[22rem] md:truncate')}>
          <span aria-hidden="true">— </span>
          {view.detail}
        </span>
      </p>
      {status === 'signed-out' ? <SignInAgain /> : null}
    </div>
  )
}

/**
 * Its own component so `usePathname` is only read when there is a link to build.
 * The path is this app's own route, but it is passed through `sameOriginPath`
 * anyway: the `next` it rides in is the one value an open-redirect check looks at.
 */
function SignInAgain() {
  const pathname = sameOriginPath(usePathname()) ?? '/dashboard'
  return (
    <Link
      href={signInHref(pathname)}
      className="inline-flex min-h-11 items-center text-[13px] font-medium text-(--color-brand) underline underline-offset-2 hover:text-(--color-brand-hover) active:brightness-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-brand)"
    >
      Sign in
    </Link>
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

/** A padlock: the session is gone. */
function SignedOutIcon() {
  return (
    <Icon>
      <rect x="3.5" y="7.5" width="9" height="6" rx="1.5" />
      <path d="M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2" />
    </Icon>
  )
}

/** A square: stopped, and not coming back by itself. */
function StoppedIcon() {
  return (
    <Icon>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
    </Icon>
  )
}
