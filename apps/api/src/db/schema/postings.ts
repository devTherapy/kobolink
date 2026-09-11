import { jsonb, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { postingKindEnum } from './enums.js'
import { newId } from './id.js'

/**
 * The unit of a money movement. A posting owns a set of `ledger_entries`
 * (B5 writes both inside one transaction); the posting row itself carries
 * no amount — the entries are the transaction, this is only its header.
 *
 * `reference` is the user-visible handle (`PaymentReferenceSchema`'s
 * `kbl_...` for a `link_payment`; B8 mints its own shape for `transfer` and
 * `topup`) and is unique so a client can poll or look one up without ever
 * seeing a `posting_id`. `idempotencyKey` is a denormalised copy of the key
 * that created this posting — `idempotency_keys` is the authority that
 * *enforces* one-posting-per-key (it stores the full cached response), this
 * column just makes "which posting did this key produce" a direct read
 * instead of a decode of a stored response body.
 */
export const postings = pgTable(
  'postings',
  {
    id: varchar('id', { length: 64 }).primaryKey().$defaultFn(newId),
    kind: postingKindEnum('kind').notNull(),
    reference: varchar('reference', { length: 64 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('postings_reference_unique').on(table.reference)],
)
