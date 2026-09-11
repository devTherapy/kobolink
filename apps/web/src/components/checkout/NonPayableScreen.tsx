import Link from 'next/link'
import type { PublicLink } from '@kobolink/contracts'
import { NON_PAYABLE_COPY, type NonPayableState } from '@/lib/checkout'
import { CheckoutCard } from './CheckoutCard'
import { AlertTriangleIcon, XCircleIcon } from './icons'

/**
 * One screen for the three ways a link can refuse a payment — rendered by
 * the server page on the initial load (`state !== 'payable'`) and by
 * `PayForm` itself when a `link_not_payable` error arrives mid-flow (a
 * single-use link a racing payer finished paying between page load and this
 * payer clicking Pay). Same component, same copy (`NON_PAYABLE_COPY`),
 * either way — never two screens that could say it two different ways.
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
 */
export function NonPayableScreen({
  state,
  link,
  headingLevel = 'h1',
}: {
  state: NonPayableState
  link: PublicLink
  headingLevel?: 'h1' | 'h2'
}) {
  const copy = NON_PAYABLE_COPY[state]
  const Icon = state === 'already-paid' ? XCircleIcon : AlertTriangleIcon
  const Heading = headingLevel

  return (
    <CheckoutCard>
      <div className="flex flex-col items-center gap-3 text-center">
        <Icon className="text-(--color-warning)" width={32} height={32} />
        <p className="truncate text-[13px] text-(--color-ink-2)">{link.merchantName}</p>
        <Heading className="text-[23px] font-semibold text-(--color-ink)">{copy.heading}</Heading>
        <p className="truncate text-[16px] text-(--color-ink-2)">{link.title}</p>
        <p className="text-[14px] text-(--color-ink-2)">{copy.body(link)}</p>
        {/* Neutral, not amber: the icon above already carries "heads up,
            this link can't be paid" — this line is reassurance, not a
            second warning, so it reads as calm fact rather than alarm. */}
        <p className="rounded-(--radius-input) bg-(--color-border-soft) px-3 py-2 text-[13px] font-medium text-(--color-ink-2)">
          No money has moved.
        </p>
        <p className="text-[13px] text-(--color-ink-2)">{copy.nextStep(link)}</p>
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
