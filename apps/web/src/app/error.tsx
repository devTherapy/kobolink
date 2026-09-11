'use client'

import { useEffect } from 'react'

/**
 * Next's root error boundary: catches anything thrown while rendering (or in
 * `generateMetadata`) that no more specific `error.tsx` further down the
 * tree already caught — see `app/l/[code]/error.tsx` for the checkout
 * route's own, more specific boundary. Without this file, an SSR failure on
 * any other route renders Next's blank, unbranded "Application error" page
 * instead of something a visitor can act on.
 *
 * Deliberately generic: this boundary can be reached from any route, not
 * only the money-moving checkout flow, so it makes no claim about payments
 * or balances — that specific, stronger guarantee belongs to the checkout
 * route's own boundary, which knows exactly what could and couldn't have
 * happened.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // No error-reporting sink is wired up yet (out of scope for this PR) —
    // the console is the only place this is currently visible.
    console.error(error)
  }, [error])

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-(--color-ground) px-4 py-10 text-center">
      <div role="alert" aria-live="assertive" className="flex flex-col items-center gap-3">
        <h1 className="text-[23px] font-semibold text-(--color-ink)">Something went wrong</h1>
        <p className="max-w-sm text-[14px] text-(--color-ink-2)">
          We hit a problem loading this page. Please try again.
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="mt-2 inline-flex min-h-11 items-center justify-center rounded-(--radius-input) bg-(--color-brand) px-5 text-[14px] font-semibold text-white hover:bg-(--color-brand-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-brand)"
        >
          Try again
        </button>
      </div>
    </main>
  )
}
