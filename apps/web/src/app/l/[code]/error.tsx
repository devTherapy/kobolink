'use client'

import { useEffect, useRef } from 'react'
import { CheckoutCard, CheckoutShell } from '@/components/checkout/CheckoutCard'

/**
 * Next's file convention for this segment: rendered whenever anything thrown
 * during `page.tsx`'s render or `generateMetadata` reaches here uncaught —
 * in practice, `resolveCheckoutLink` (`@/lib/checkout`) throwing
 * `CheckoutUnavailableError` because the public-link API could not be
 * reached or answered a 5xx. Without this file that failure rendered Next's
 * blank "Application error" page — no title, no "did my money move" answer,
 * nothing a payer who just followed a payment link can act on.
 *
 * Safe to say "No money has moved" unconditionally here: this boundary can
 * only be reached from a failure that happened *resolving the link*, which
 * is strictly before `PayForm` ever exists to submit a payment. `PayForm`'s
 * own transport/error handling (see its own file) is what covers everything
 * that can go wrong once a payer has actually pressed Pay.
 *
 * `retry`, not `reset`, is what "Try again" calls: `reset()` alone clears
 * the boundary's error state and re-renders the same already-thrown-away
 * tree without re-running `page.tsx`/`generateMetadata` — the outage that
 * put the payer here would still be showing after the API recovered. As of
 * this Next version `retry` re-fetches and re-renders the segment (see
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`
 * §retry/§reset) and is the documented default; `reset` is kept only as a
 * defensive fallback in case a future/older runtime ever calls this
 * component without it, and `window.location.reload()` is the last resort
 * if somehow neither function is available at all.
 *
 * No `generateMetadata` here — error boundaries are Client Components and
 * cannot export it — so the outage screen would otherwise ship with no
 * `<title>` at all. Rendered inline via React's own `<title>` element
 * (hoisted into `<head>` automatically), per the same Next doc's
 * global-error guidance.
 */
export default function CheckoutError({
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
    <CheckoutShell>
      <title>We couldn&apos;t load this payment link — Kobolink</title>
      <CheckoutCard>
        <div role="alert" aria-live="assertive" className="flex flex-col items-center gap-3 text-center">
          <h1 ref={headingRef} tabIndex={-1} className="text-[23px] font-semibold text-(--color-ink) outline-none">
            We couldn&apos;t load this payment link
          </h1>
          <p className="text-[14px] text-(--color-ink-2)">
            Something went wrong reaching Kobolink&apos;s servers. No money has moved.
          </p>
          <button
            type="button"
            onClick={handleTryAgain}
            className="mt-2 inline-flex min-h-11 items-center justify-center rounded-(--radius-input) bg-(--color-brand) px-5 text-[14px] font-semibold text-white hover:bg-(--color-brand-hover) active:bg-(--color-brand-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-brand)"
          >
            Try again
          </button>
        </div>
      </CheckoutCard>
    </CheckoutShell>
  )
}
