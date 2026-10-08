'use client'

import Link from 'next/link'
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/Button'

/**
 * Next's file convention for this segment: catches `loadLinkDetail` throwing
 * `LinkDetailUnavailableError` (`@/lib/link-detail`) — the API unreachable, or
 * a 5xx. Its own boundary rather than `app/dashboard/error.tsx`'s, whose
 * copy is about "your dashboard" — this names the link.
 *
 * Renders inside `DashboardLayout`, so the header and "Log out" stay on
 * screen. A failed *read* changes nothing, and the copy says so without
 * claiming anything about money (this screen only reads, same as F3's
 * dashboard boundary); the next step is either retry or go back.
 *
 * `retry`, not `reset`: `reset()` alone re-renders the already-failed tree
 * without re-running the page's fetch, so "Try again" would keep showing the
 * same error after the API recovered.
 */
export default function LinkDetailError({
  error,
  retry,
  reset,
}: {
  error: Error & { digest?: string }
  retry?: () => void
  reset: () => void
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    // No error-reporting sink is wired up yet; the console is the only place this shows.
    console.error(error)
    headingRef.current?.focus()
  }, [error])

  function handleTryAgain() {
    if (retry) {
      retry()
    } else if (reset) {
      reset()
    } else {
      window.location.reload()
    }
  }

  return (
    <div role="alert" aria-live="assertive" className="flex flex-col items-center gap-3 py-16 text-center">
      <h1 ref={headingRef} tabIndex={-1} className="text-[23px] font-semibold text-(--color-ink) outline-none">
        We couldn&apos;t load this link
      </h1>
      <p className="max-w-sm text-[14px] text-(--color-ink-2)">
        Something went wrong reaching Kobolink&apos;s servers. The link and its payments are unaffected — this only
        stopped them loading.
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <Button onClick={handleTryAgain}>Try again</Button>
        <Link
          href="/dashboard"
          className="inline-flex min-h-11 items-center justify-center rounded-(--radius-input) px-4 text-[14px] font-medium text-(--color-brand) hover:bg-(--color-brand-tint) active:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-brand)"
        >
          Back to all links
        </Link>
      </div>
    </div>
  )
}
