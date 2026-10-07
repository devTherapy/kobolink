import { type LinkStatus, resolveLink } from '@kobolink/contracts'
import { toIso } from '../db/iso-timestamp.js'
import { type LinkStats, ZERO_LINK_STATS } from '../links/link-stats.js'

export interface DashboardLinkRow {
  code: string
  status: LinkStatus
  isReusable: boolean
  expiresAt: Date | null
}

export interface DashboardTotals {
  totalCollectedKobo: number
  paymentCount: number
  activeLinks: number
}

/**
 * The pure half of `computeDashboardStats`: folds a merchant's links and
 * their ledger-derived per-link stats into the three strip numbers. No I/O,
 * so it is unit-testable without Postgres. Money is only ever added —
 * integer kobo in, integer kobo out — and `activeLinks` is `resolveLink()`
 * at `asOf` (the contract's definition), never `status === 'active'`.
 */
export function summariseDashboard(
  links: readonly DashboardLinkRow[],
  statsByCode: ReadonlyMap<string, LinkStats>,
  asOf: Date,
): DashboardTotals {
  let totalCollectedKobo = 0
  let paymentCount = 0
  let activeLinks = 0

  for (const link of links) {
    const stats = statsByCode.get(link.code) ?? ZERO_LINK_STATS
    totalCollectedKobo += stats.totalPaidKobo
    paymentCount += stats.paymentCount

    const resolution = resolveLink(
      {
        status: link.status,
        isReusable: link.isReusable,
        expiresAt: link.expiresAt === null ? null : toIso(link.expiresAt),
        paymentCount: stats.paymentCount,
      },
      asOf,
    )
    if (resolution.kind === 'payable') activeLinks += 1
  }

  return { totalCollectedKobo, paymentCount, activeLinks }
}
