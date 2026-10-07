'use client'

import { formatNaira, type PaymentLink } from '@kobolink/contracts'
import { Card } from '@/components/ui/Card'
import { useLiveLink } from '@/components/live/useLiveLink'
import { formatShortDate } from '@/lib/format'

export interface LinkFiguresProps {
  /** As the server rendered it. */
  link: PaymentLink
  /** When that render's reads finished — see `LinkDetailData.asOf`. */
  asOf?: string | undefined
}

/**
 * The link's own figures (DESIGN-SPEC §4.2). Money goes through `formatNaira`
 * (kobo in, naira out — the contract owns the only `/ 100`); an open-amount
 * link says "Any amount" in words, never ₦0. Counters are the API's, never
 * recomputed from the payments list: that list is paginated, so a sum over it
 * would be wrong the moment there is a second page.
 *
 * A client component only so the figures can follow the live stream (PLAN.md
 * F7): the page renders it with the link it fetched, so the HTML on arrival
 * is the same, and `useLiveLink` swaps in a newer link when one arrives for
 * this code. The payment counters themselves are not bumped by a
 * `payment.completed` event — the refresh that event schedules brings the
 * API's own numbers, which is the only place they are ever computed.
 */
export function LinkFigures({ link: rendered, asOf }: LinkFiguresProps) {
  const link = useLiveLink(rendered, asOf)
  const figures: { label: string; value: string }[] = [
    { label: 'Amount', value: link.amountKobo === null ? 'Any amount' : formatNaira(link.amountKobo) },
    { label: 'Collected', value: formatNaira(link.totalPaidKobo) },
    { label: 'Successful payments', value: link.paymentCount.toLocaleString('en-NG') },
    { label: 'Type', value: link.isReusable ? 'Reusable' : 'Single use' },
    { label: 'Expires', value: link.expiresAt ? formatShortDate(link.expiresAt) : 'Never' },
    { label: 'Created', value: formatShortDate(link.createdAt) },
  ]

  return (
    <Card as="section" className="flex flex-col gap-3">
      <h2 className="text-[16px] font-semibold text-(--color-ink)">Details</h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        {figures.map((figure) => (
          <div key={figure.label} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-[13px] text-(--color-ink-3)">{figure.label}</dt>
            <dd className="tabular break-words text-[14px] font-medium text-(--color-ink)">{figure.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}
