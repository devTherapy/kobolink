import Link from 'next/link'
import type { PublicLink } from '@kobolink/contracts'
import { NON_PAYABLE_COPY, type NonPayableState } from '@/lib/checkout'
import { CheckoutCard } from './CheckoutCard'
import { AlertTriangleIcon } from './icons'
import { FocusHeadingOnMount } from './FocusHeadingOnMount'

/**
 * One screen for the three ways a link can refuse a payment — rendered by
 * the server page on the initial load (`state !== 'payable'`) and by
 * `PayForm` itself when a `link_not_payable` error arrives mid-flow (a
 * single-use link a racing payer finished paying between page load and this
 * payer clicking Pay). Same component, same copy (`NON_PAYABLE_COPY`),
 * either way — never two screens that could say it two different ways.
 *
 * A plain Server Component, deliberately: nothing here needs a hook, so the
 * initial-load render from the server page ships this screen's HTML with
 * zero client JS. The one bit of behavior that *does* need a hook — moving
 * focus to the heading for `PayForm`'s client-side `link_not_payable` swap —
 * is isolated in `FocusHeadingOnMount`, the sole client-only sliver, rather
 * than making this whole component (and every visitor who only ever sees
 * the initial SSR render of a disabled/expired/already-paid link) pay for a
 * `'use client'` boundary it does not need.
 *
 * Every variant states the thing a worried payer actually wants to know
 * first: no money moved. Then it names what happened, then the next step —
 * the design spec's own rule for a failure state, applied here even though
 * nothing failed yet, because "why can't I pay this" deserves the same
 * honesty as "why did my payment fail".
 *
 * `headingLevel` exists because this component renders in two different
 * heading contexts: the server page's own non-payable branch, where this is
 * the whole page and its heading is the document's `<h1>`, and `PayForm`'s
 * `link_not_payable` branch, where the page's real `<h1>` is the link title
 * still visible above it — a second `<h1>` there would be a duplicate.
 *
 * `state` is nullable for one specific case: a `link_not_payable` error that
 * did not carry `state` at all. Rather than guessing (defaulting to
 * `'disabled'` fabricates a merchant action nobody confirmed happened), a
 * `null` state renders neutral copy that says only what is actually known —
 * this link cannot be paid right now.
 */
export function NonPayableScreen({
  state,
  link,
  headingLevel = 'h1',
  autoFocus = false,
}: {
  state: NonPayableState | null
  link: PublicLink
  headingLevel?: 'h1' | 'h2'
  /** Focus the heading on mount — only correct when this is the result of a
   *  client-side transition (`PayForm`'s `link_not_payable` swap), never for
   *  the initial page load, which must not steal focus from the top of the
   *  document. */
  autoFocus?: boolean
}) {
  const copy = state ? NON_PAYABLE_COPY[state] : null
  const heading = copy ? copy.heading : 'This link cannot be paid right now'
  const body = copy ? copy.body(link) : null
  const nextStep = copy ? copy.nextStep(link) : 'Please try again in a moment.'

  return (
    <CheckoutCard>
      {/* `role="status"`/`aria-live="polite"`: correct for both contexts —
          inert on the initial SSR render (nothing has "changed" yet, so a
          screen reader just reads it top-down like any other content), and
          an actual live announcement for `PayForm`'s client-side swap. */}
      <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 text-center">
        {/* One icon for all three states, always amber: `XCircleIcon` is
            reserved for `PayForm.FailedResult`'s actual payment failure
            (danger-red) — reusing it here for `already-paid` would make a
            merely-unpayable link look like a harder failure than it is. */}
        <AlertTriangleIcon className="text-(--color-warning)" width={32} height={32} />
        <p className="truncate text-[13px] text-(--color-ink-2)">{link.merchantName}</p>
        <FocusHeadingOnMount
          active={autoFocus}
          as={headingLevel}
          className="text-[23px] font-semibold text-(--color-ink) outline-none"
        >
          {heading}
        </FocusHeadingOnMount>
        <p className="truncate text-[16px] text-(--color-ink-2)">{link.title}</p>
        {body ? <p className="text-[14px] text-(--color-ink-2)">{body}</p> : null}
        {/* Neutral, not amber: the icon above already carries "heads up,
            this link can't be paid" — this line is reassurance, not a
            second warning, so it reads as calm fact rather than alarm. */}
        <p className="rounded-(--radius-input) bg-(--color-border-soft) px-3 py-2 text-[13px] font-medium text-(--color-ink-2)">
          No money has moved.
        </p>
        <p className="text-[13px] text-(--color-ink-2)">{nextStep}</p>
        <Link
          href="/"
          className="mt-2 inline-flex min-h-11 items-center justify-center rounded-(--radius-input) px-4 text-[13px] font-medium text-(--color-brand) hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-brand)"
        >
          Go to Kobolink
        </Link>
      </div>
    </CheckoutCard>
  )
}
