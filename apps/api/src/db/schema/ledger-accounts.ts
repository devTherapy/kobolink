import { sql } from 'drizzle-orm'
import { index, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { ledgerAccountKindEnum } from './enums.js'
import { newId } from './id.js'
import { users } from './users.js'

/**
 * A wallet is just another `kind`; a merchant's receivable account is just
 * another `kind`. Phase 2 (B8) adds no table here, only more rows — that is
 * the whole point of the ledger decision in DESIGN-SPEC.md §3.
 *
 * `ownerUserId` is nullable to hold the one row that is not owned by a
 * user at all: the `external_funding` account, the simulated gateway's
 * source/sink for money entering or leaving the ledger from outside it. A
 * `users` row can't stand in for it — `UserRoleSchema` only has `merchant`
 * and `customer`, and a synthetic user would be a system account wearing a
 * disguise. The two partial unique indexes below encode the two invariants
 * that decision otherwise leaves implicit: at most one account per
 * (user, kind) pair, and at most one `external_funding` account, period.
 */
export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: varchar('id', { length: 64 }).primaryKey().$defaultFn(newId),
    ownerUserId: varchar('owner_user_id', { length: 64 }).references(() => users.id),
    kind: ledgerAccountKindEnum('kind').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('NGN'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('ledger_accounts_owner_idx').on(table.ownerUserId),
    uniqueIndex('ledger_accounts_owner_kind_unique')
      .on(table.ownerUserId, table.kind)
      .where(sql`${table.ownerUserId} is not null`),
    uniqueIndex('ledger_accounts_external_funding_singleton')
      .on(table.kind)
      .where(sql`${table.kind} = 'external_funding'`),
  ],
)
