import { randomUUID } from 'node:crypto'
import { API, TransferResponseSchema } from '@kobolink/contracts'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerCustomer, registerMerchant } from './support/register-user.js'

/**
 * A genuine network-retry scenario, forced deterministically: two requests
 * carrying the *exact same* `Idempotency-Key` **and** the exact same body
 * both reach `WalletService.decideTransfer` before either has committed —
 * `IdempotencyService.lookup` finds no row for either, so both proceed into
 * their own `compute()`. Both then contend on the sender's `ledger_accounts`
 * row lock; the loser only discovers, once it is finally admitted and tries
 * its own `postings` insert, that the winner already used this
 * `(idempotencyScope, idempotencyKey)` — via `postings_idempotency_scope_key_unique`.
 *
 * Before this fix, `insertPosting` treated that unique-violation as an
 * unconditional `idempotency_mismatch`, even though the body is identical —
 * a lie (`moneyMoved: false`) that would push a legitimately-retrying client
 * to retry again under a *fresh* key and double-spend. This test forces the
 * exact interleaving (a held-open raw lock on the sender's account, released
 * only once both real requests are provably queued behind it — the same
 * technique `wallet-transfer-concurrency.integration.test.ts` uses for the
 * double-spend race) and asserts both requests come back `201` with
 * byte-identical bodies, and that only one posting, and one debit, ever hit
 * the ledger.
 */
describe('POST /api/wallet/transfer — idempotent replay under real lock contention (real Postgres via Testcontainers)', () => {
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

  function transfer(cookie: string, key: string, toPhone: string, amountKobo: number) {
    return getCtx().request.post(API.wallet.transfer).set('Cookie', cookie).set('Idempotency-Key', key).send({ toPhone, amountKobo })
  }

  function pool(): Pool {
    return new Pool({ connectionString: getCtx().connectionString })
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** Same technique as `wallet-transfer-concurrency.integration.test.ts`'s own copy. */
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

  it('two requests, the same Idempotency-Key, the same body, forced onto the same lock: both succeed, identically, with exactly one posting and one debit', async () => {
    // Balance covers both amounts, so the loser's own insufficient-funds
    // check (evaluated on the now-already-debited balance, before it ever
    // reaches the posting insert) does not mask the real race this test
    // means to force — the reviewer's own repro used the same shape.
    const sender = await registerCustomer(getCtx(), 'idem-race-sender@example.test', 'A Customer', '+2348030002001')
    const funded = await topup(sender.cookie, 200_000)
    if (funded.status !== 201) throw new Error(`fixture topup failed: ${funded.status} ${JSON.stringify(funded.body)}`)
    const senderAccountId = TransferResponseSchema.parse(funded.body).wallet.accountId

    const recipient = await registerMerchant(getCtx(), 'idem-race-recipient@example.test', 'A Merchant', '+2348030002002')

    const key = idempotencyKey()
    const rawClient = new Client({ connectionString: getCtx().connectionString })
    await rawClient.connect()
    const activity = pool()
    try {
      // Hold the exact row `decideTransfer`'s own lock will contend on,
      // *before* either real request is ever sent, so both are genuinely
      // queued behind it, not just hopefully overlapping.
      await rawClient.query('BEGIN')
      await rawClient.query('SELECT id FROM ledger_accounts WHERE id = $1 FOR NO KEY UPDATE', [senderAccountId])

      // Same Idempotency-Key, same body, dispatched on the wire before we
      // ever start polling for the block.
      const firstPromise = Promise.resolve(transfer(sender.cookie, key, recipient.phone ?? '', 40_000))
      const secondPromise = Promise.resolve(transfer(sender.cookie, key, recipient.phone ?? '', 40_000))

      const blocked = await waitForBlockedBackendCount(activity, 2)
      expect(blocked).toBeGreaterThanOrEqual(2)

      // Release the lock: Postgres admits the two waiters in FIFO order —
      // the second only reaches its own `postings` insert once the first
      // has fully committed (posting, ledger entries, and the
      // `idempotency_keys` row all in one transaction).
      await rawClient.query('COMMIT')

      const [first, second] = await Promise.all([firstPromise, secondPromise])

      // Never a mismatch, never a 500 — both a genuine replay of the exact
      // same request, both 201, with the *identical* stored response body.
      expect(first.status).toBe(201)
      expect(second.status).toBe(201)
      expect(second.body).toEqual(first.body)
      const body = TransferResponseSchema.parse(first.body)
      expect(body.wallet.balanceKobo).toBe(160_000)

      const db = pool()
      try {
        const postings = await db.query<{ count: number }>(`select count(*)::int as count from postings where idempotency_key = $1`, [
          key,
        ])
        expect(postings.rows[0]?.count).toBe(1)

        const debits = await db.query<{ count: number }>(
          `select count(*)::int as count from ledger_entries where account_id = $1 and amount_kobo = -40000`,
          [senderAccountId],
        )
        expect(debits.rows[0]?.count).toBe(1)

        const balance = await db.query<{ sum: string }>(
          `select coalesce(sum(amount_kobo), 0)::text as sum from ledger_entries where account_id = $1`,
          [senderAccountId],
        )
        // 200,000 topped up, exactly one 40,000 debit — never two.
        expect(Number(balance.rows[0]?.sum)).toBe(160_000)
      } finally {
        await db.end()
      }
    } finally {
      await activity.end()
      await rawClient.query('ROLLBACK').catch(() => undefined)
      await rawClient.end()
    }
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
