import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { newId } from './id.js'
import { userRoleEnum } from './enums.js'

/**
 * One table, every role. A customer paying by QR and a merchant collecting
 * are the same entity with different capabilities — never a `merchants`
 * table. `role` decides what a user is allowed to do; it never decides
 * which table a row lives in.
 *
 * `displayName` is not in PLAN.md's abbreviated B1 column list, but every
 * contract shape that returns a user (`UserSchema.displayName`, and
 * `PaymentLink.merchantName`, which B3 will read off this same column) needs
 * one. Added so a row round-trips the contract exactly instead of forcing a
 * later feature to bolt it on — see the PR description for the full
 * reasoning.
 */
export const users = pgTable(
  'users',
  {
    id: varchar('id', { length: 64 }).primaryKey().$defaultFn(newId),
    role: userRoleEnum('role').notNull(),
    email: varchar('email', { length: 254 }).notNull(),
    /** E.164, e.g. +2348031234567. Nullable — not every merchant registers a phone. */
    phone: varchar('phone', { length: 20 }),
    passwordHash: text('password_hash').notNull(),
    displayName: varchar('display_name', { length: 80 }).notNull(),
    // `mode: 'date'`, not `'string'` — see src/db/iso-timestamp.ts for why:
    // node-postgres already hands back a real `Date`, and only `toIso()`
    // from that file, not the driver's raw text, satisfies the contract's
    // `IsoDateTimeSchema`.
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('users_email_unique').on(table.email),
    // Partial: many users may have no phone at all, but two users can never
    // share one — it is how Phase 2 wallet transfers look a recipient up.
    uniqueIndex('users_phone_unique')
      .on(table.phone)
      .where(sql`${table.phone} is not null`),
  ],
)
