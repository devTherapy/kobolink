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
 */
export default function CheckoutError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    // No error-reporting sink is wired up yet (out of scope for this PR) —
    // the console is the only place this is currently visible.
    console.error(error)
    headingRef.current?.focus()
  }, [error])

  return (
    <CheckoutShell>
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
            onClick={() => reset()}
            className="mt-2 inline-flex min-h-11 items-center justify-center rounded-(--radius-input) bg-(--color-brand) px-5 text-[14px] font-semibold text-white hover:bg-(--color-brand-hover) active:bg-(--color-brand-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-brand)"
          >
            Try again
          </button>
        </div>
      </CheckoutCard>
    </CheckoutShell>
  )
}
