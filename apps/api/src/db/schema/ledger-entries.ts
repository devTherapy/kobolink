import { bigint, index, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core'
import { ledgerAccounts } from './ledger-accounts.js'
import { newId } from './id.js'
import { postings } from './postings.js'

/**
 * Double-entry lines. Every money movement in this system is a set of these
 * rows, never a status column on some other table — a client that could
 * write here directly could forge a payment, so B5's integration suite
 * proves it cannot.
 *
 * `amountKobo` is `bigint` in Postgres so a running balance can never
 * silently lose precision, but the driver reads it back as a JS `number`
 * (`mode: 'number'`, which throws instead of truncating past
 * `Number.MAX_SAFE_INTEGER`) — matching `packages/contracts`' own
 * `KoboSchema`/`SignedKoboSchema`, which bound amounts the same way. No
 * `numeric`, no `money`, no float, and the app layer never juggles a
 * `bigint`/`number` split the contracts don't have.
 *
 * The invariant "entries within a posting sum to zero" is enforced in
 * Postgres itself by a deferred constraint trigger — see the hand-written
 * migration `drizzle/0001_ledger_entries_balance_trigger.sql` — not only in
 * application code, so a bug in a future service can't post an unbalanced
 * entry no matter what path it takes to the database.
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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('ledger_entries_account_idx').on(table.accountId),
    index('ledger_entries_posting_idx').on(table.postingId),
  ],
)
