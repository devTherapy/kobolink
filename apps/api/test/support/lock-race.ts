import type { Pool } from 'pg'

/**
 * Shared by every test that deterministically forces a Postgres row-lock
 * race rather than hoping a `Promise.all` lands in the right window —
 * `wallet-transfer-concurrency.integration.test.ts`,
 * `wallet-transfer-idempotency-race.integration.test.ts`, and
 * `wallet-transfer-mutual-deadlock.integration.test.ts` each hold a raw
 * lock open on a row a real request will contend on, then poll this before
 * releasing it, so the test proves both real requests are *genuinely*
 * queued behind the lock at the Postgres lock-manager level before the
 * assertions that follow ever run.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Polls a dedicated connection until at least `atLeast` *other* backends are genuinely waiting on a lock. */
export async function waitForBlockedBackendCount(activity: Pool, atLeast: number, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let last = 0
  while (Date.now() < deadline) {
    const result = await activity.query<{ count: number }>(
      `select count(*)::int as count
       from pg_stat_activity
       where datname = current_database()
         and wait_event_type = 'Lock'
         and pid <> pg_backend_pid()`,
    )
    last = result.rows[0]?.count ?? 0
    if (last >= atLeast) return last
    await sleep(15)
  }
  return last
}
