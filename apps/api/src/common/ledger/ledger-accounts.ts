import type { LedgerAccountKind } from '@kobolink/contracts'
import { and, eq } from 'drizzle-orm'
import type { Executor } from '../../db/db.service.js'
import { isUniqueViolation } from '../../db/pg-error.js'
import * as schema from '../../db/schema/index.js'

/**
 * Get-or-create for a `ledger_accounts` row — the exact technique
 * `payments/payments.service.ts`'s `PaymentsService.getOrCreateAccount`
 * (B5) already worked out across three review rounds, lifted here so B8's
 * `WalletService` can reuse it verbatim instead of re-solving the same
 * race. `merchant_receivable`/`wallet` rows are looked up (and, the first
 * time, created) by `(kind, ownerUserId)`; `external_funding` — the
 * simulated gateway's singleton source/sink for a `topup` posting's other
 * leg, `ownerUserId: null` — by `kind` alone.
 *
 * Either unique index can still lose a create race to a concurrent
 * transaction (two distinct first-time wallet top-ups racing to create the
 * `external_funding` singleton, say, or two first-time transfers to the
 * same never-before-paid recipient). The insert runs inside a nested
 * `executor.transaction(...)`, which — when `executor` is itself already a
 * `DbTransaction` (every real caller here: `WalletService`, same as
 * `PaymentsService`) — `drizzle-orm/node-postgres` implements as a real
 * `SAVEPOINT`/`ROLLBACK TO SAVEPOINT`. A plain `executor.insert(...)` would
 * instead abort the *whole* outer transaction on the unique-violation
 * (Postgres `25P02`, "current transaction is aborted"), and the
 * `findLedgerAccount` re-read below would fail immediately on that dead
 * transaction instead of recovering the race's winner — exactly the bug
 * B5's second review round found and fixed; this file exists so B8 cannot
 * reintroduce it.
 */
export async function getOrCreateLedgerAccount(
  executor: Executor,
  kind: LedgerAccountKind,
  ownerUserId: string | null,
): Promise<{ id: string }> {
  const existing = await findLedgerAccount(executor, kind, ownerUserId)
  if (existing !== undefined) return existing

  const constraint = ownerUserId === null ? 'ledger_accounts_external_funding_singleton' : 'ledger_accounts_owner_kind_unique'
  try {
    return await executor.transaction(async (savepoint) => {
      const [row] = await savepoint.insert(schema.ledgerAccounts).values({ kind, ownerUserId }).returning({ id: schema.ledgerAccounts.id })
      if (row === undefined) throw new Error('ledger-accounts: insert returned no row')
      return row
    })
  } catch (error) {
    if (isUniqueViolation(error, constraint)) {
      const raced = await findLedgerAccount(executor, kind, ownerUserId)
      if (raced !== undefined) return raced
    }
    throw error
  }
}

export async function findLedgerAccount(
  executor: Executor,
  kind: LedgerAccountKind,
  ownerUserId: string | null,
): Promise<{ id: string } | undefined> {
  const where =
    ownerUserId === null
      ? eq(schema.ledgerAccounts.kind, kind)
      : and(eq(schema.ledgerAccounts.kind, kind), eq(schema.ledgerAccounts.ownerUserId, ownerUserId))
  const [row] = await executor.select({ id: schema.ledgerAccounts.id }).from(schema.ledgerAccounts).where(where).limit(1)
  return row
}
