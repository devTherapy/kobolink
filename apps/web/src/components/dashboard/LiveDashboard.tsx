'use client'

import { useMemo } from 'react'
import { formatNaira, type DashboardStats, type PaymentLink } from '@kobolink/contracts'
import { useDashboardStream } from '@/components/live/DashboardStreamProvider'
import { mergeDashboard } from '@/lib/live-dashboard'
import { LinksTable } from './LinksTable'
import { StatStrip } from './StatStrip'

export interface LiveDashboardProps {
  /** The server-rendered snapshot — the stat strip and the first page of links. */
  stats: DashboardStats
  links: PaymentLink[]
}

/**
 * The dashboard's stat strip and links table, kept current by the stream
 * (PLAN.md F7). `DashboardPage` stays a Server Component and renders this with
 * the figures it fetched, so the first paint is the same server-rendered HTML
 * as before — this island only adds what happens *after* it: a payment in
 * another tab moves the numbers without a reload.
 *
 * It owns no state. The view is `mergeDashboard(props, events)`: what the
 * server rendered with whatever has arrived since laid over it. When
 * `router.refresh()` (scheduled by `DashboardStreamProvider` for every event)
 * delivers newer props, the events they already include drop out of the merge
 * by themselves — nothing to reset, nothing that can drift from the server.
 *
 * Rendered outside a provider (a page test, static markup) the event list is
 * empty and this is exactly `StatStrip` + `LinksTable`.
 *
 * The visible change is not enough for someone who cannot see it, so a
 * screen-reader-only `role="status"` says what arrived. Always mounted (a live
 * region inserted with its text is not reliably announced) and empty until a
 * payment lands.
 */
export function LiveDashboard({ stats, links }: LiveDashboardProps) {
  const { events } = useDashboardStream()
  const view = useMemo(() => mergeDashboard({ stats, links }, events), [stats, links, events])

  return (
    <>
      <StatStrip stats={view.stats} />
      <LinksTable links={view.links} />
      <p role="status" className="sr-only">
        {view.latestPayment === null
          ? null
          : `New payment received: ${formatNaira(view.latestPayment.amountKobo)} from ${view.latestPayment.payerName}.`}
      </p>
    </>
  )
}
