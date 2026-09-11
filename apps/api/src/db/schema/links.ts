import { desc, sql } from 'drizzle-orm'
import { bigint, boolean, check, index, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core'
import { linkStatusEnum } from './enums.js'
import { users } from './users.js'

/**
 * `code` is the primary key, not a separate `id` — resolving `/l/{code}`
 * (B4, unauthenticated, on the hot path of every WhatsApp click) is then one
 * indexed lookup, and Postgres itself is what rejects a collision when a
 * new code is inserted; B3 catches the unique-violation and retries with a
 * fresh code rather than checking-then-inserting.
 *
 * `status` only ever moves between `active` and `disabled` — a merchant's
 * deliberate switch (`LinkStatusSchema`). Expiry and single-use exhaustion
 * are *derived*, by `resolveLink()` in `packages/contracts`, from
 * `expiresAt`, `isReusable` and whether a successful `link_payment` posting
 * references this code — never written back to a `status` column on a
 * clock tick, so the row never needs an out-of-band job to stay honest and
 * every client asks the same question the same way.
 *
 * `amountKobo` is nullable: null means the payer names the amount at
 * checkout (`CreateLinkRequestSchema.amountKobo` is `.nullable()`), same
 * `bigint`-column/`number`-mode choice as `ledger_entries.amount_kobo` (see
 * that file for the precision caveat — irrelevant here, since a link's
 * amount is already bounded by `AmountKoboSchema` the same way a single
 * ledger entry is) and for the same reason — this is a money value,
 * contracts bound it as an integer, never a float. `createdAt`/`expiresAt`
 * are `mode: 'date'`, not `'string'` — see src/db/iso-timestamp.ts; a row
 * read straight off this table only round-trips `PaymentLink`/`PublicLink`
 * exactly once both of those are mapped through `toIso()`.
 */
export const links = pgTable(
  'links',
  {
    code: varchar('code', { length: 8 }).primaryKey(),
    merchantUserId: varchar('merchant_user_id', { length: 64 })
      .notNull()
      .references(() => users.id),
    title: varchar('title', { length: 120 }).notNull(),
    description: varchar('description', { length: 500 }),
    amountKobo: bigint('amount_kobo', { mode: 'number' }),
    status: linkStatusEnum('status').notNull().default('active'),
    isReusable: boolean('is_reusable').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('links_merchant_created_idx').on(table.merchantUserId, desc(table.createdAt)),
    check('links_amount_kobo_positive', sql`${table.amountKobo} is null or ${table.amountKobo} > 0`),
  ],
)
