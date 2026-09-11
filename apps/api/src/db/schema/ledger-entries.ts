import { sql } from 'drizzle-orm'
import { bigint, check, index, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core'
import { ledgerAccounts } from './ledger-accounts.js'
import { newId } from './id.js'
import { postings } from './postings.js'

/**
 * Double-entry lines. Every money movement in this system is a set of these
 * rows, never a status column on some other table — a client that could
 * write here directly could forge a payment, so B5's integration suite
 * proves it cannot. The rows are append-only: `postings`/`ledger_entries`
 * accept `INSERT` but reject `UPDATE`/`DELETE` outright — see the
 * hand-written migration `drizzle/0002_ledger_entries_append_only.sql` and
 * `test/ledger-entries-append-only.integration.test.ts`. Without that, the
 * balance trigger below is not the guarantee its own comment claims: moving
 * one entry to a different `posting_id`, or deleting it, re-sums only the
 * posting(s) touched by that statement and can leave an *other* posting
 * unbalanced with no trigger ever re-checking it.
 *
 * `amountKobo` is `bigint` in Postgres so a running balance can never
 * silently lose precision, but the driver reads a single row's value back
 * as a JS `number` (`mode: 'number'`). That mode does **not** throw past
 * `Number.MAX_SAFE_INTEGER` — `mapFromDriverValue` is a bare `Number(value)`,
 * which *silently rounds*. It is safe here only because every value this
 * column ever holds is bounded by `AmountKoboSchema`
 * (±₦10,000,000 → ±1,000,000,000 kobo), far inside the safe-integer range —
 * matching `packages/contracts`' own `KoboSchema`/`SignedKoboSchema`, which
 * bound amounts the same way. No `numeric`, no `money`, no float. **This
 * bound does not extend to an aggregate.** `SUM(amount_kobo)` over many rows
 * (a wallet balance, B8) can exceed `Number.MAX_SAFE_INTEGER` even though
 * every individual entry cannot; any such aggregate/balance read must ask
 * Postgres for the sum as `bigint` text (or use `mode: 'bigint'` for that
 * query) and either keep it a JS `bigint` or verify `Number.isSafeInteger`
 * before narrowing it — never trust a plain `Number(sum)` the way a single
 * row's value can be trusted here.
 *
 * The invariant "entries within a posting sum to zero" is enforced in
 * Postgres itself by a deferred constraint trigger — see the hand-written
 * migration `drizzle/0001_ledger_entries_balance_trigger.sql` — not only in
 * application code, so a bug in a future service can't post an unbalanced
 * entry no matter what path it takes to the database. A CHECK rules out the
 * one-line version of "unbalanced": a zero-amount entry can never appear at
 * all, on either side of a posting.
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: varchar('id', { length: 64 }).primaryKey().$defaultFn(newId),
    postingId: varchar('posting_id', { length: 64 })
      .notNull()
      .references(() => postings.id),
    accountId: varchar('account_id', { length: 64 })
      .notNull()
      .references(() => ledgerAccounts.id),
    amountKobo: bigint('amount_kobo', { mode: 'number' }).notNull(),
    // mode: 'date' — see src/db/iso-timestamp.ts.
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('ledger_entries_account_idx').on(table.accountId),
    index('ledger_entries_posting_idx').on(table.postingId),
    check('ledger_entries_amount_kobo_nonzero', sql`${table.amountKobo} <> 0`),
  ],
)
