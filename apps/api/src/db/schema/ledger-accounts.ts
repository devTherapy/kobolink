import { sql } from 'drizzle-orm'
import { check, index, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
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
 * disguise. Three constraints below encode the invariants that decision
 * otherwise leaves implicit: the `ledger_accounts_external_funding_ownerless`
 * CHECK ties the nullability of `ownerUserId` to the `kind` directly (a
 * `wallet` or `merchant_receivable` row can never be ownerless, an
 * `external_funding` row can never have an owner — a row-level guarantee no
 * pair of separately-checkable columns gives you on its own), and the two
 * partial unique indexes cap it at one account per (user, kind) pair and at
 * most one `external_funding` account, period.
 */
export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: varchar('id', { length: 64 }).primaryKey().$defaultFn(newId),
    ownerUserId: varchar('owner_user_id', { length: 64 }).references(() => users.id),
    kind: ledgerAccountKindEnum('kind').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('NGN'),
    // mode: 'date' — see src/db/iso-timestamp.ts.
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('ledger_accounts_owner_idx').on(table.ownerUserId),
    uniqueIndex('ledger_accounts_owner_kind_unique')
      .on(table.ownerUserId, table.kind)
      .where(sql`${table.ownerUserId} is not null`),
    uniqueIndex('ledger_accounts_external_funding_singleton')
      .on(table.kind)
      .where(sql`${table.kind} = 'external_funding'`),
    check(
      'ledger_accounts_external_funding_ownerless',
      sql`(${table.kind} = 'external_funding') = (${table.ownerUserId} is null)`,
    ),
    // `CurrencySchema` is a single literal ('NGN') today, not yet an enum —
    // a CHECK is the equivalent guard until (if ever) a second currency
    // makes a real enum column worth the migration.
    check('ledger_accounts_currency_ngn', sql`${table.currency} = 'NGN'`),
  ],
)
