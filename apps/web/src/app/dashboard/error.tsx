'use client'

import { useEffect, useRef } from 'react'

/**
 * Next's file convention for this segment: catches `loadDashboardData`
 * throwing `DashboardUnavailableError` (`@/lib/dashboard`) — a transport
 * failure or a 5xx reaching the stats/links endpoints — same shape as
 * `app/l/[code]/error.tsx`'s own boundary for the checkout route.
 *
 * Renders inside `DashboardLayout`: the header (and its working "Log out")
 * stay on screen, only the content area below it is replaced, so a merchant
 * whose stats failed to load is never also locked out of signing out.
 *
 * "No money moved" isn't the right reassurance here — nothing on this
 * screen moves money, it only reads it — so the copy says what actually
 * failed (loading the merchant's own data) instead of borrowing the
 * checkout boundary's line verbatim.
 *
 * `retry`, not `reset`: `reset()` alone re-renders the already-failed tree
 * without re-running `page.tsx`'s fetch, so "Try again" would keep showing
 * the same error even after the API recovered. `window.location.reload()` is
 * the last-resort fallback if neither function is available.
 */
export default function DashboardError({
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
    // No error-reporting sink is wired up yet (out of scope for this PR) —
    // the console is the only place this is currently visible.
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
        We couldn&apos;t load your dashboard
      </h1>
      <p className="max-w-sm text-[14px] text-(--color-ink-2)">
        Something went wrong reaching Kobolink&apos;s servers. Your links and payments are unaffected — this only
        stopped them from loading.
      </p>
      <button
        type="button"
        onClick={handleTryAgain}
        className="mt-2 inline-flex min-h-11 items-center justify-center rounded-(--radius-input) bg-(--color-brand) px-5 text-[14px] font-semibold text-white hover:bg-(--color-brand-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-brand)"
      >
        Try again
      </button>
    </div>
  )
}
