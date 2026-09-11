import { sql } from 'drizzle-orm'
import { check, jsonb, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { postingKindEnum } from './enums.js'
import { newId } from './id.js'

/**
 * The unit of a money movement. A posting owns a set of `ledger_entries`
 * (B5 writes both inside one transaction); the posting row itself carries
 * no amount — the entries are the transaction, this is only its header.
 * Postings are as append-only as their entries: `reference`, `metadata`,
 * everything — see `drizzle/0002_ledger_entries_append_only.sql`. A
 * mistaken or abandoned checkout attempt is never "fixed" by editing a
 * posting after the fact; it is a service-layer concern (B5) to model
 * separately, before a posting is written at all.
 *
 * `reference` is the user-visible handle (`PaymentReferenceSchema`'s
 * `kbl_...` for a `link_payment`; B8 mints its own shape for `transfer` and
 * `topup`) and is unique so a client can poll or look one up without ever
 * seeing a `posting_id`.
 *
 * `idempotencyScope`/`idempotencyKey` mirror `idempotency_keys`' own
 * `(scope, key)` identity (`packages/contracts/README.md`, "Idempotency":
 * `scope` is the authenticated user id for wallet endpoints, the endpoint
 * path for unauthenticated checkout) and are unique together, so "which
 * posting did this replayed request already produce" is one indexed
 * lookup directly on `postings` — `idempotency_keys` is still the
 * authority that *enforces* one-posting-per-key (it stores the full
 * cached response and is what a service actually writes to first), this
 * pair is a denormalised, queryable copy of the same identity, not a
 * second source of truth. Both are nullable together: not every posting
 * kind necessarily originates from one client-idempotent write, even
 * though every kind that exists so far (`link_payment`, `transfer`,
 * `topup`) does — but nullable *independently* would be a trap. Postgres
 * unique indexes never treat two NULLs as equal, so
 * `postings_idempotency_scope_key_unique` silently does not fire for two
 * rows that both have `idempotency_scope IS NULL` and the *same* non-null
 * `idempotency_key` — the CHECK below closes exactly that gap by
 * forbidding the mixed state (one set, the other not) outright, so the
 * only way to have a non-null key is to also have a non-null scope, which
 * the partial unique index *does* correctly enforce.
 */
export const postings = pgTable(
  'postings',
  {
    id: varchar('id', { length: 64 }).primaryKey().$defaultFn(newId),
    kind: postingKindEnum('kind').notNull(),
    reference: varchar('reference', { length: 64 }).notNull(),
    idempotencyScope: varchar('idempotency_scope', { length: 128 }),
    idempotencyKey: varchar('idempotency_key', { length: 128 }),
    metadata: jsonb('metadata'),
    // mode: 'date' — see src/db/iso-timestamp.ts.
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('postings_reference_unique').on(table.reference),
    uniqueIndex('postings_idempotency_scope_key_unique')
      .on(table.idempotencyScope, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    check(
      'postings_idempotency_scope_key_nullability_matches',
      sql`(${table.idempotencyScope} is null) = (${table.idempotencyKey} is null)`,
    ),
  ],
)
