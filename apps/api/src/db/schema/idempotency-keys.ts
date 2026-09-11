import { integer, jsonb, pgTable, primaryKey, timestamp, varchar } from 'drizzle-orm/pg-core'

/**
 * The idempotency boundary for every money-moving write
 * (`checkout.initialize`, `checkout.verify`, `wallet.transfer`,
 * `wallet.topup`). `scope` is the authenticated user id for the wallet
 * endpoints and the endpoint path for the unauthenticated checkout ones
 * (`packages/contracts/README.md`, "Idempotency"); the primary key is the
 * pair, so two different scopes may reuse the same client-chosen key with
 * no collision.
 *
 * The full response — `responseStatus` and `responseBody` — is stored, not
 * a pointer to one, so a replay is answered without re-running any
 * business logic at all: read the row, return exactly what was returned
 * the first time. `requestHash` is what turns a replay with a *different*
 * body into `idempotency_mismatch` instead of a silently wrong cached
 * answer.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    scope: varchar('scope', { length: 128 }).notNull(),
    key: varchar('key', { length: 128 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.key] })],
)
