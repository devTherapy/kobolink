import { eq } from 'drizzle-orm'
import { type DashboardStats, DashboardStatsSchema } from '@kobolink/contracts'
import type { Executor } from '../db/db.service.js'
import { toIso } from '../db/iso-timestamp.js'
import * as schema from '../db/schema/index.js'
import { computeLinkStatsBatch } from '../links/link-stats.js'
import { summariseDashboard } from './summarise-dashboard.js'

/**
 * The same snapshot `DashboardEvent`'s `payment.completed`/`link.created`/
 * `link.updated` variants embed (`packages/contracts/src/dashboard.ts`) —
 * built here, once, so a dashboard event's numbers and (once F3/F7 exist)
 * a plain `GET /api/dashboard/stats` read are computed the exact same way
 * and can never disagree with each other, the same reasoning
 * `link-stats.ts`'s own doc comment gives for sharing `computeLinkStats`
 * between `LinksService` and `PaymentsService`.
 *
 * `activeLinks` cannot be a single SQL aggregate — "resolves to payable"
 * is `resolveLink()`, a `packages/contracts` function this repo has one
 * copy of on purpose (the same check the public checkout page and both
 * mobile apps run), not SQL this file would have to keep in sync with it
 * by hand. So this reads every one of the merchant's links (nothing this
 * app has today makes that list large enough to page) and its per-link
 * stats in one batch (`computeLinkStatsBatch`), then runs `resolveLink`
 * once per row (`summariseDashboard`, the pure half) — the same per-row
 * shape `LinksService.list` already builds a `PaymentLink` from, just
 * counted instead of rendered. Also the read behind
 * `GET /api/dashboard/stats` (B9, via `DashboardStatsService`), so the
 * stream's embedded snapshot and a plain read cannot disagree.
 */
export async function computeDashboardStats(
  executor: Executor,
  merchantId: string,
  asOf: Date = new Date(),
): Promise<DashboardStats> {
  const linkRows = await executor
    .select({
      code: schema.links.code,
      status: schema.links.status,
      isReusable: schema.links.isReusable,
      expiresAt: schema.links.expiresAt,
    })
    .from(schema.links)
    .where(eq(schema.links.merchantUserId, merchantId))

  const stats = await computeLinkStatsBatch(
    executor,
    linkRows.map((row) => row.code),
    merchantId,
  )

  const { totalCollectedKobo, paymentCount, activeLinks } = summariseDashboard(linkRows, stats, asOf)

  // Same caveat as link-stats.ts's own: `ledger_entries.amount_kobo` reads
  // back as `mode: 'number'`, safe per row but not for a sum across
  // however many of a merchant's postings — verify before trusting it.
  if (!Number.isSafeInteger(totalCollectedKobo)) {
    throw new Error(`dashboard: totalCollectedKobo for merchant ${merchantId} exceeded Number.MAX_SAFE_INTEGER`)
  }

  return DashboardStatsSchema.parse({
    totalCollectedKobo,
    paymentCount,
    activeLinks,
    asOf: toIso(asOf),
  })
}
