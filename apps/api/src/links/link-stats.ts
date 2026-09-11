import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import type { Executor } from '../db/db.service.js'
import * as schema from '../db/schema/index.js'

export interface LinkStats {
  paymentCount: number
  totalPaidKobo: number
}

export const ZERO_LINK_STATS: LinkStats = { paymentCount: 0, totalPaidKobo: 0 }

/**
 * Derives `paymentCount`/`totalPaidKobo` from successful `link_payment`
 * postings — never a separately-written counter a client (or a bug) could
 * drift from the ledger. Extracted from `LinksService` (B3) so B5's
 * `PaymentsService` reads links and their stats with the exact same
 * convention it writes postings to satisfy, from inside its own posting
 * transaction (`executor` is a `DbTransaction` there, the pooled `Database`
 * everywhere else) — see that file's own doc comment for why the two must
 * never drift apart.
 *
 * Attribution convention (B3, unchanged by B5): a `link_payment` posting's
 * `metadata` carries `linkCode` (`postings.metadata ->> 'linkCode' = code`),
 * and the credit side of that posting — the positive entry against the
 * merchant's own `merchant_receivable` account — is the amount that counts.
 */
export async function computeLinkStats(executor: Executor, code: string, merchantId: string): Promise<LinkStats> {
  const batch = await computeLinkStatsBatch(executor, [code], merchantId)
  return batch.get(code) ?? ZERO_LINK_STATS
}

export async function computeLinkStatsBatch(
  executor: Executor,
  codes: string[],
  merchantId: string,
): Promise<Map<string, LinkStats>> {
  const result = new Map<string, LinkStats>()
  if (codes.length === 0) return result

  const linkCodeExpr = sql<string>`${schema.postings.metadata} ->> 'linkCode'`

  const rows = await executor
    .select({ linkCode: linkCodeExpr, amountKobo: schema.ledgerEntries.amountKobo })
    .from(schema.postings)
    .innerJoin(schema.ledgerEntries, eq(schema.ledgerEntries.postingId, schema.postings.id))
    .innerJoin(schema.ledgerAccounts, eq(schema.ledgerAccounts.id, schema.ledgerEntries.accountId))
    .where(
      and(
        eq(schema.postings.kind, 'link_payment'),
        eq(schema.ledgerAccounts.kind, 'merchant_receivable'),
        eq(schema.ledgerAccounts.ownerUserId, merchantId),
        gt(schema.ledgerEntries.amountKobo, 0),
        inArray(linkCodeExpr, codes),
      ),
    )

  for (const row of rows) {
    if (row.linkCode === null) continue
    const existing = result.get(row.linkCode) ?? { paymentCount: 0, totalPaidKobo: 0 }
    result.set(row.linkCode, {
      paymentCount: existing.paymentCount + 1,
      totalPaidKobo: existing.totalPaidKobo + row.amountKobo,
    })
  }

  // See ledger-entries.ts's own doc comment: `mode: 'number'` is safe for
  // one bounded row but never for an aggregate — verify before trusting a
  // summed totalPaidKobo the same way a single row's value is trusted.
  for (const [code, stats] of result) {
    if (!Number.isSafeInteger(stats.totalPaidKobo)) {
      throw new Error(`links: totalPaidKobo for ${code} exceeded Number.MAX_SAFE_INTEGER`)
    }
  }

  return result
}
