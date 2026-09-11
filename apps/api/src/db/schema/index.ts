/**
 * Drizzle schema — desired-state source for `drizzle-kit generate` (config:
 * `../../../drizzle.config.ts`, which points at this file, not the
 * directory) and the single module `DbService` builds its typed client
 * from.
 *
 * B0 wired Postgres through Drizzle and proved the connection was real with
 * no tables at all. B1 (this file and its siblings) adds the whole Phase 1
 * + Phase 2 domain schema in one pass — `ledger_accounts` and
 * `ledger_entries` already support a `wallet` account kind and a
 * `transfer`/`topup` posting kind, per DESIGN-SPEC.md §3, so B8 (Phase 2)
 * is new rows and new service code, never a migration that reconstructs
 * history.
 */
export * from './enums.js'
export * from './id.js'
export * from './idempotency-keys.js'
export * from './ledger-accounts.js'
export * from './ledger-entries.js'
export * from './links.js'
export * from './postings.js'
export * from './sessions.js'
export * from './users.js'
