/**
 * Drizzle schema — desired-state source for `drizzle-kit generate`.
 *
 * B0 wires Postgres through Drizzle and proves the connection is real; it
 * does not own the domain schema. B1 adds `users`, `sessions`,
 * `ledger_accounts`, `ledger_entries`, `links` and `idempotency_keys` here.
 * Intentionally empty until then — the wiring (`DbService`, the Testcontainers
 * harness, `drizzle.config.ts`) does not need a single table to prove itself:
 * it runs `select 1` through the real driver against a real container.
 */
export {}
