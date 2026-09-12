import { eq, sql } from 'drizzle-orm'
import type { Executor } from '../db/db.service.js'
import * as schema from '../db/schema/index.js'

/**
 * A wallet's balance is never a stored column — PLAN.md's B8 row and
 * `db/schema/ledger-accounts.ts`'s own doc comment are explicit that a
 * cached balance a bug (or a client) could drift from the ledger is exactly
 * what the whole ledger design exists to rule out. This is the one place
 * that balance is ever computed, from `sum(ledger_entries.amount_kobo)` for
 * the account, so `WalletService`'s read path (`GET /api/wallet`) and its
 * write path (`decideTransfer`'s balance check, run inside the same
 * transaction as the posting it might refuse) can never disagree — same
 * reasoning `link-stats.ts`'s `computeLinkStats` gives for being the one
 * place link stats are derived.
 *
 * `ledger_entries.amount_kobo` reads back as `mode: 'number'`, safe for any
 * one row (bounded by `AmountKoboSchema`) but never for an aggregate across
 * however many entries a long-lived wallet accumulates — that file's own
 * doc comment. A `SUM` in Postgres itself has no such bound, so this asks
 * for the sum as text (never letting the driver narrow it to `number`
 * first) and only converts to a JS `number` after checking it still fits —
 * throwing, not silently truncating, if a wallet ever really did accumulate
 * more than `Number.MAX_SAFE_INTEGER` kobo of lifetime activity.
 */
export async function computeWalletBalance(executor: Executor, accountId: string): Promise<number> {
  const [row] = await executor
    .select({ balance: sql<string>`coalesce(sum(${schema.ledgerEntries.amountKobo}), 0)::text` })
    .from(schema.ledgerEntries)
    .where(eq(schema.ledgerEntries.accountId, accountId))

  const raw = row?.balance ?? '0'
  const big = BigInt(raw)
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`wallet: balance for account ${accountId} exceeded Number.MAX_SAFE_INTEGER`)
  }
  return Number(big)
}
