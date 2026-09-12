import { randomUUID } from 'node:crypto'
import { API, TransferResponseSchema, ApiErrorSchema } from '@kobolink/contracts'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerCustomer, registerMerchant } from './support/register-user.js'

/**
 * The double-spend race `decideTransfer`'s `SELECT ... FOR UPDATE` on the
 * sender's `ledger_accounts` row exists to close (`wallet.service.ts`'s own
 * doc comment). B5's reviewer explicitly called out that a "concurrent"
 * test built from two `Promise.all`-wrapped calls only *hopes* to catch a
 * race — it usually doesn't lose, because both requests typically clear
 * every step before either commits, well clear of the actual contention
 * window. This file forces the contention deterministically instead,
 * exactly `checkout-verify.integration.test.ts`'s "deterministically forces
 * the getOrCreateAccount unique-violation race" test does for B5's own
 * hardest concurrency bug: a dedicated raw connection holds
 * `SELECT ... FOR UPDATE` open on the sender's `ledger_accounts` row
 * *before* either real transfer request is sent, so both real requests are
 * queued behind it at the Postgres lock-manager level — proven by polling
 * `pg_stat_activity` for a genuinely blocked backend, not by a fixed
 * `sleep` the test just hopes was long enough — and only released once
 * both are provably waiting. Whichever one Postgres then admits first
 * commits its debit; the other's own `SELECT ... FOR UPDATE` (issued by
 * `decideTransfer` itself, once it gets the lock) blocks in turn until the
 * first is done, then re-reads the now-current (already-debited) balance —
 * so it is a live decision on fresh data, never a stale one — and is
 * correctly refused for insufficient funds. If the lock did nothing, both
 * requests would have read the *same* pre-debit balance and both would
 * succeed, overdrawing the sender; this test fails loudly in exactly that
 * shape if the lock is ever removed or narrowed.
 */
describe('POST /api/wallet/transfer — deterministic double-spend race (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined

  beforeAll(async () => {
    ctx = await startApiTestContext()
  }, 120_000)

  afterAll(async () => {
    await ctx?.teardown()
  })

  function idempotencyKey(): string {
    return `test-idem-${randomUUID()}`
  }

  function topup(cookie: string, amountKobo: number) {
    return getCtx().request.post(API.wallet.topup).set('Cookie', cookie).set('Idempotency-Key', idempotencyKey()).send({ amountKobo })
  }

  function transfer(cookie: string, toPhone: string, amountKobo: number) {
    return getCtx()
      .request.post(API.wallet.transfer)
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey())
      .send({ toPhone, amountKobo })
  }

  function pool(): Pool {
    return new Pool({ connectionString: getCtx().connectionString })
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** Same technique as `checkout-verify.integration.test.ts`'s own copy — polls a dedicated connection until some *other* backend is genuinely waiting on a lock. */
  async function waitForBlockedBackendCount(activity: Pool, atLeast: number, timeoutMs = 5_000): Promise<number> {
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

  it('two transfers racing the same balance, forced onto the same lock: exactly one succeeds, the other is a clean insufficient_funds, and the sender is never overdrawn', async () => {
    // Balance covers exactly one of the two transfers, never both — the
    // scenario a race that isn't actually closed would overdraw.
    const sender = await registerCustomer(getCtx(), 'race-sender@example.test', 'A Customer', '+2348030001001')
    const funded = await topup(sender.cookie, 100_000)
    if (funded.status !== 201) throw new Error(`fixture topup failed: ${funded.status} ${JSON.stringify(funded.body)}`)
    const senderAccountId = TransferResponseSchema.parse(funded.body).wallet.accountId

    const recipientA = await registerMerchant(getCtx(), 'race-recipient-a@example.test', 'Recipient A', '+2348030001002')
    const recipientB = await registerMerchant(getCtx(), 'race-recipient-b@example.test', 'Recipient B', '+2348030001003')

    const rawClient = new Client({ connectionString: getCtx().connectionString })
    await rawClient.connect()
    const activity = pool()
    try {
      // Hold the exact row `decideTransfer`'s own `FOR UPDATE` will contend
      // on, *before* either real request is ever sent.
      await rawClient.query('BEGIN')
      await rawClient.query('SELECT id FROM ledger_accounts WHERE id = $1 FOR UPDATE', [senderAccountId])

      // Both real requests are genuinely on the wire (supertest/superagent
      // does not dispatch until `.then`/`.end` is called — wrapping in
      // `Promise.resolve` forces that now, the same reasoning
      // `checkout-verify.integration.test.ts`'s own forced-race test gives)
      // before we ever start polling for the block.
      const firstPromise = Promise.resolve(transfer(sender.cookie, recipientA.phone ?? '', 100_000))
      const secondPromise = Promise.resolve(transfer(sender.cookie, recipientB.phone ?? '', 100_000))

      // Prove *both* are really queued behind our held lock — not just
      // "eventually, if the timing happens to line up" — before releasing
      // it. If this never reaches 2, the race was never engaged at all and
      // the rest of the test would pass for the wrong reason.
      const blocked = await waitForBlockedBackendCount(activity, 2)
      expect(blocked).toBeGreaterThanOrEqual(2)

      // Release the lock: Postgres admits the two waiters in FIFO order,
      // one at a time, each re-reading the balance fresh once it holds the
      // lock — never the pre-debit value both would have seen without it.
      await rawClient.query('COMMIT')

      const [first, second] = await Promise.all([firstPromise, secondPromise])
      const statuses = [first.status, second.status].sort()
      expect(statuses).toEqual([201, 422])

      const winner = first.status === 201 ? first : second
      const loser = first.status === 201 ? second : first
      expect(ApiErrorSchema.parse(loser.body).code).toBe('insufficient_funds')
      expect(ApiErrorSchema.parse(loser.body).moneyMoved).toBe(false)
      const winnerBody = TransferResponseSchema.parse(winner.body)
      expect(winnerBody.wallet.balanceKobo).toBe(0)

      // The ground truth: the sender's derived balance (sum of their own
      // ledger_entries) never went negative, and exactly one 100,000-kobo
      // debit posted — not zero, not two.
      const db = pool()
      try {
        const balance = await db.query<{ sum: string }>(
          `select coalesce(sum(amount_kobo), 0)::text as sum from ledger_entries where account_id = $1`,
          [senderAccountId],
        )
        // 100,000 topped up, 100,000 debited by the sole winning transfer.
        expect(Number(balance.rows[0]?.sum)).toBe(0)

        const debits = await db.query<{ count: number }>(
          `select count(*)::int as count from ledger_entries where account_id = $1 and amount_kobo = -100000`,
          [senderAccountId],
        )
        expect(debits.rows[0]?.count).toBe(1)
      } finally {
        await db.end()
      }
    } finally {
      await activity.end()
      // If an assertion above threw before COMMIT, this releases the lock
      // so it never dangles into a later test.
      await rawClient.query('ROLLBACK').catch(() => undefined)
      await rawClient.end()
    }
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
