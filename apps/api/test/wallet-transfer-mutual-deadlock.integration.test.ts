import { randomUUID } from 'node:crypto'
import { API, ApiErrorSchema, TransferResponseSchema } from '@kobolink/contracts'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerCustomer } from './support/register-user.js'

/**
 * Two wallets transferring to each other at the same time (A→B while B→A)
 * used to deadlock in Postgres, deterministically: `decideTransfer`'s row
 * lock on the *sender's* `ledger_accounts` row was taken `FOR UPDATE`, and
 * the credit leg's `ledger_entries` insert makes Postgres's own
 * foreign-key check take a `FOR KEY SHARE` lock on the *recipient's* row to
 * validate it. A→B holds `FOR UPDATE` on A and then needs `FOR KEY SHARE`
 * on B; B→A holds `FOR UPDATE` on B and then needs `FOR KEY SHARE` on A —
 * each waits on a lock the other already holds, a real deadlock Postgres's
 * own detector has to break by killing one side, which surfaced as a bare
 * `500 {"code":"internal"}` with no `moneyMoved` on a money-moving write.
 *
 * The fix changes that sender lock to `FOR NO KEY UPDATE`, which never
 * conflicts with `FOR KEY SHARE` (see `wallet.service.ts`'s own doc comment
 * for the full lock-compatibility argument) — so this specific cross-wait
 * can no longer form, for a two-party pair or any longer cycle.
 *
 * This test forces the exact interleaving the old code deadlocked on,
 * deterministically — not a hopeful `Promise.all` — using the same
 * held-open-raw-lock technique `wallet-transfer-concurrency.integration.test.ts`
 * and `wallet-transfer-idempotency-race.integration.test.ts` use for their
 * own races: a raw connection holds *each* side's own sender-lock row
 * before either real request is sent, both real requests are proven
 * genuinely queued behind their own lock, and then both raw locks are
 * released together so the two real transfers are admitted and proceed in
 * lockstep — the precise shape that used to deadlock. It runs several
 * independent rounds (fresh accounts each time) because a race that is only
 * narrowed, not closed, could still pass once by luck.
 */
describe('POST /api/wallet/transfer — mutual concurrent transfers never deadlock (real Postgres via Testcontainers)', () => {
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

  async function runMutualTransferRound(round: number): Promise<void> {
    const a = await registerCustomer(getCtx(), `deadlock-a-${round}@example.test`, 'Customer A', `+234803${round}001001`)
    const b = await registerCustomer(getCtx(), `deadlock-b-${round}@example.test`, 'Customer B', `+234803${round}001002`)

    const fundedA = await topup(a.cookie, 100_000)
    const fundedB = await topup(b.cookie, 100_000)
    if (fundedA.status !== 201) throw new Error(`fixture topup A failed: ${fundedA.status} ${JSON.stringify(fundedA.body)}`)
    if (fundedB.status !== 201) throw new Error(`fixture topup B failed: ${fundedB.status} ${JSON.stringify(fundedB.body)}`)
    const accountA = TransferResponseSchema.parse(fundedA.body).wallet.accountId
    const accountB = TransferResponseSchema.parse(fundedB.body).wallet.accountId

    const rawA = new Client({ connectionString: getCtx().connectionString })
    const rawB = new Client({ connectionString: getCtx().connectionString })
    await rawA.connect()
    await rawB.connect()
    const activity = pool()
    try {
      // Hold each side's own sender-lock row before either real request is
      // sent, so both real requests are forced to queue behind their own
      // lock and are then admitted together — the interleaving the old
      // `FOR UPDATE` code deadlocked on.
      await rawA.query('BEGIN')
      await rawA.query('SELECT id FROM ledger_accounts WHERE id = $1 FOR NO KEY UPDATE', [accountA])
      await rawB.query('BEGIN')
      await rawB.query('SELECT id FROM ledger_accounts WHERE id = $1 FOR NO KEY UPDATE', [accountB])

      const aToBPromise = Promise.resolve(transfer(a.cookie, b.phone ?? '', 30_000))
      const bToAPromise = Promise.resolve(transfer(b.cookie, a.phone ?? '', 30_000))

      const blocked = await waitForBlockedBackendCount(activity, 2)
      expect(blocked).toBeGreaterThanOrEqual(2)

      // Release both raw holds together so the two real transfers are
      // admitted essentially simultaneously, each immediately needing the
      // *other's* account row for its own credit leg's FK check.
      await Promise.all([rawA.query('COMMIT'), rawB.query('COMMIT')])

      const [aToB, bToA] = await Promise.all([aToBPromise, bToAPromise])

      // The bug: one side got a bare 500 with no typed error and no
      // `moneyMoved`. Neither response may ever be that, win or lose.
      for (const response of [aToB, bToA]) {
        expect(response.status).not.toBe(500)
        if (response.status >= 400) {
          const error = ApiErrorSchema.parse(response.body)
          expect(typeof error.code).toBe('string')
          expect(error.code).not.toBe('internal')
        }
      }

      // With both sides funded well past what either transfer needs, the
      // fix should let both succeed outright — no lock conflict remains to
      // force either one to fail at all.
      expect(aToB.status).toBe(201)
      expect(bToA.status).toBe(201)
    } finally {
      await activity.end()
      await rawA.query('ROLLBACK').catch(() => undefined)
      await rawB.query('ROLLBACK').catch(() => undefined)
      await rawA.end()
      await rawB.end()
    }
  }

  it('round 1: A→B and B→A forced onto the same mutual-lock interleaving never deadlocks', async () => {
    await runMutualTransferRound(1)
  })

  it('round 2: repeated, to rule out a narrowed rather than closed race', async () => {
    await runMutualTransferRound(2)
  })

  it('round 3: repeated again, same reason', async () => {
    await runMutualTransferRound(3)
  })

  it('round 4: repeated again, same reason', async () => {
    await runMutualTransferRound(4)
  })

  it('round 5: repeated again, same reason', async () => {
    await runMutualTransferRound(5)
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
