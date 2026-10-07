import { randomUUID } from 'node:crypto'
import {
  API,
  ApiErrorSchema,
  DashboardStatsSchema,
  InitializeCheckoutResponseSchema,
  LinkListResponseSchema,
  PaymentLinkSchema,
} from '@kobolink/contracts'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerCustomer, registerMerchant } from './support/register-user.js'

/**
 * `GET /api/dashboard/stats` — PLAN.md's B9 row. Every payment in this file
 * goes through the real B5 path (`POST /api/checkout/initialize` then
 * `/verify`), so the ledger rows the numbers are derived from are written by
 * the production write path, not seeded by a helper that already knows the
 * answer. The expected totals are then re-derived with a raw SQL query over
 * `ledger_entries` — an oracle that shares no code with the endpoint.
 */
describe('GET /api/dashboard/stats (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined
  let pool: Pool | undefined

  beforeAll(async () => {
    ctx = await startApiTestContext()
    pool = new Pool({ connectionString: ctx.connectionString })
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    await ctx?.teardown()
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }

  function getPool(): Pool {
    if (pool === undefined) throw new Error('beforeAll did not produce a pool — see its own failure above')
    return pool
  }

  function idempotencyKey(): string {
    return `test-idem-${randomUUID()}`
  }

  async function createLink(cookie: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const response = await getCtx()
      .request.post(API.links.collection)
      .set('Cookie', cookie)
      .send({ title: 'A link', ...overrides })
    if (response.status !== 201) throw new Error(`fixture create failed: ${response.status} ${JSON.stringify(response.body)}`)
    return PaymentLinkSchema.parse(response.body).code
  }

  /** The real B5 path. `fail@` is the simulated gateway's decline address (`checkout-payments-listing`). */
  async function pay(code: string, amountKobo: number, payerEmail = 'ada@example.test'): Promise<void> {
    const init = await getCtx()
      .request.post(API.checkout.initialize)
      .set('Idempotency-Key', idempotencyKey())
      .send({ code, amountKobo, payerName: 'A Payer', payerEmail })
    if (init.status !== 201) throw new Error(`fixture initialize failed: ${JSON.stringify(init.body)}`)
    const { reference } = InitializeCheckoutResponseSchema.parse(init.body)
    const verify = await getCtx()
      .request.post(API.checkout.verify)
      .set('Idempotency-Key', idempotencyKey())
      .send({ reference })
    if (verify.status !== 200) throw new Error(`fixture verify failed: ${JSON.stringify(verify.body)}`)
  }

  async function getStats(cookie: string) {
    const response = await getCtx().request.get(API.dashboard.stats).set('Cookie', cookie)
    expect(response.status).toBe(200)
    return { body: response.body as unknown, stats: DashboardStatsSchema.parse(response.body) }
  }

  /** Independent of the endpoint: positive `merchant_receivable` entries of `link_payment` postings, straight from the ledger. */
  async function ledgerTruth(merchantId: string): Promise<{ totalKobo: number; postings: number }> {
    const result = await getPool().query<{ total: string; postings: number }>(
      `select coalesce(sum(e.amount_kobo), 0)::text as total, count(distinct p.id)::int as postings
         from ledger_entries e
         join ledger_accounts a on a.id = e.account_id
         join postings p on p.id = e.posting_id
        where p.kind = 'link_payment'
          and a.kind = 'merchant_receivable'
          and a.owner_user_id = $1
          and e.amount_kobo > 0`,
      [merchantId],
    )
    return { totalKobo: Number(result.rows[0]?.total ?? 0), postings: result.rows[0]?.postings ?? 0 }
  }

  async function ledgerRowCount(): Promise<number> {
    const result = await getPool().query<{ n: number }>(`select count(*)::int as n from ledger_entries`)
    return result.rows[0]?.n ?? 0
  }

  describe('authentication and authorisation', () => {
    it('401s a request with no session credential', async () => {
      const response = await getCtx().request.get(API.dashboard.stats)
      expect(response.status).toBe(401)
      expect(ApiErrorSchema.parse(response.body).code).toBe('unauthenticated')
    })

    it('401s a garbage session cookie', async () => {
      const response = await getCtx().request.get(API.dashboard.stats).set('Cookie', 'kobolink_session=not-a-real-token')
      expect(response.status).toBe(401)
      expect(ApiErrorSchema.parse(response.body).code).toBe('unauthenticated')
    })

    it('403s an authenticated customer, the same as every other merchant route', async () => {
      const customer = await registerCustomer(getCtx(), 'stats-customer@example.test')
      const response = await getCtx().request.get(API.dashboard.stats).set('Cookie', customer.cookie)
      expect(response.status).toBe(403)
      expect(ApiErrorSchema.parse(response.body).code).toBe('forbidden')
    })
  })

  describe('numbers', () => {
    it('200: zeros and the exact contract shape for a merchant with no links at all', async () => {
      const merchant = await registerMerchant(getCtx(), 'stats-empty@example.test')

      const before = Date.now()
      const { body, stats } = await getStats(merchant.cookie)

      expect(stats).toMatchObject({ totalCollectedKobo: 0, paymentCount: 0, activeLinks: 0 })
      expect(Object.keys(body as object).sort()).toEqual(['activeLinks', 'asOf', 'paymentCount', 'totalCollectedKobo'])
      expect(Math.abs(new Date(stats.asOf).getTime() - before)).toBeLessThan(10_000)
    })

    it('200: a link with no payments is zero collected, and counts as active', async () => {
      const merchant = await registerMerchant(getCtx(), 'stats-unpaid@example.test')
      await createLink(merchant.cookie)

      const { stats } = await getStats(merchant.cookie)

      expect(stats).toMatchObject({ totalCollectedKobo: 0, paymentCount: 0, activeLinks: 1 })
    })

    it('totals equal the merchant\'s ledger postings; another merchant\'s postings, declines and wallet top-ups are excluded; active follows resolveLink', async () => {
      const merchant = await registerMerchant(getCtx(), 'stats-main@example.test')
      const other = await registerMerchant(getCtx(), 'stats-other@example.test')

      const reusable = await createLink(merchant.cookie, { isReusable: true })
      const singleUse = await createLink(merchant.cookie, { isReusable: false })
      const toDisable = await createLink(merchant.cookie, { isReusable: true })
      const toExpire = await createLink(merchant.cookie, { isReusable: true })
      await createLink(merchant.cookie, { isReusable: true }) // untouched: no payments, still active
      const declinedOnly = await createLink(merchant.cookie, { isReusable: true })

      await pay(reusable, 150_050)
      await pay(reusable, 250_000)
      await pay(singleUse, 300_000) // single-use, now paid: Paid, not active
      await pay(toDisable, 40_000)
      await pay(toExpire, 12_345)
      await pay(declinedOnly, 500_000, 'fail@example.test') // declined: no posting, no money

      // Disabled and expired links keep the money they already collected but stop being active.
      const disable = await getCtx()
        .request.patch(API.links.status(toDisable))
        .set('Cookie', merchant.cookie)
        .send({ status: 'disabled' })
      expect(disable.status).toBe(200)
      await getPool().query(`update links set expires_at = now() - interval '1 day' where code = $1`, [toExpire])

      // Noise that must never reach this merchant's numbers.
      const otherLink = await createLink(other.cookie, { isReusable: true })
      await pay(otherLink, 999_900)
      const topup = await getCtx()
        .request.post(API.wallet.topup)
        .set('Cookie', merchant.cookie)
        .set('Idempotency-Key', idempotencyKey())
        .send({ amountKobo: 777_000 })
      expect(topup.status).toBe(201)

      const { stats } = await getStats(merchant.cookie)

      // 150_050 + 250_000 + 300_000 + 40_000 + 12_345
      expect(stats.totalCollectedKobo).toBe(752_395)
      expect(stats.paymentCount).toBe(5)
      // reusable, the untouched link and declinedOnly. Not singleUse (Paid), toDisable (Disabled), toExpire (Expired).
      expect(stats.activeLinks).toBe(3)

      // The oracle: the same figures straight from ledger_entries.
      const truth = await ledgerTruth(merchant.userId)
      expect(stats.totalCollectedKobo).toBe(truth.totalKobo)
      expect(stats.paymentCount).toBe(truth.postings)

      // Every one of this merchant's postings balances to zero (the debit side is external_funding).
      const unbalanced = await getPool().query(
        `select p.id
           from postings p
           join ledger_entries e on e.posting_id = p.id
          where p.id in (
            select e2.posting_id from ledger_entries e2
              join ledger_accounts a2 on a2.id = e2.account_id
             where a2.owner_user_id = $1)
          group by p.id
         having sum(e.amount_kobo) <> 0`,
        [merchant.userId],
      )
      expect(unbalanced.rows).toEqual([])

      // The other merchant sees exactly their own payment — not ours.
      const otherStats = (await getStats(other.cookie)).stats
      expect(otherStats).toMatchObject({ totalCollectedKobo: 999_900, paymentCount: 1, activeLinks: 1 })
      expect(otherStats.totalCollectedKobo).toBe((await ledgerTruth(other.userId)).totalKobo)

      // The strip agrees with the table beneath it (GET /api/links sums the same ledger rows).
      const list = await getCtx().request.get(API.links.collection).set('Cookie', merchant.cookie)
      const links = LinkListResponseSchema.parse(list.body).items
      expect(links.reduce((sum, link) => sum + link.totalPaidKobo, 0)).toBe(stats.totalCollectedKobo)
      expect(links.reduce((sum, link) => sum + link.paymentCount, 0)).toBe(stats.paymentCount)
    })

    it('reflects a new payment on the very next read, with no cache and no second posting from a repeated read', async () => {
      const merchant = await registerMerchant(getCtx(), 'stats-replay@example.test')
      const code = await createLink(merchant.cookie, { isReusable: true })
      await pay(code, 20_000)

      const first = (await getStats(merchant.cookie)).stats
      const rowsAfterFirst = await ledgerRowCount()
      const second = (await getStats(merchant.cookie)).stats

      expect(second).toMatchObject({
        totalCollectedKobo: first.totalCollectedKobo,
        paymentCount: first.paymentCount,
        activeLinks: first.activeLinks,
      })
      expect(await ledgerRowCount()).toBe(rowsAfterFirst)

      await pay(code, 30_000)
      const third = (await getStats(merchant.cookie)).stats
      expect(third).toMatchObject({ totalCollectedKobo: 50_000, paymentCount: 2 })
    })
  })

  describe('a client cannot choose, forge or write', () => {
    it('ignores a merchantId / userId query parameter: the numbers are always the session\'s own', async () => {
      const merchant = await registerMerchant(getCtx(), 'stats-scope-a@example.test')
      const victim = await registerMerchant(getCtx(), 'stats-scope-b@example.test')
      const victimLink = await createLink(victim.cookie, { isReusable: true })
      await pay(victimLink, 88_800)

      const response = await getCtx()
        .request.get(`${API.dashboard.stats}?merchantId=${victim.userId}&userId=${victim.userId}`)
        .set('Cookie', merchant.cookie)

      expect(response.status).toBe(200)
      expect(DashboardStatsSchema.parse(response.body)).toMatchObject({ totalCollectedKobo: 0, paymentCount: 0, activeLinks: 0 })
    })

    it('has no write path: POST and PUT with forged numbers do not succeed and change nothing', async () => {
      const merchant = await registerMerchant(getCtx(), 'stats-forge@example.test')
      const rowsBefore = await ledgerRowCount()
      const forged = { totalCollectedKobo: 9_999_999, paymentCount: 99, activeLinks: 99 }

      const post = await getCtx().request.post(API.dashboard.stats).set('Cookie', merchant.cookie).send(forged)
      const put = await getCtx().request.put(API.dashboard.stats).set('Cookie', merchant.cookie).send(forged)

      expect(post.status).toBeGreaterThanOrEqual(400)
      expect(put.status).toBeGreaterThanOrEqual(400)
      expect(await ledgerRowCount()).toBe(rowsBefore)
      expect((await getStats(merchant.cookie)).stats).toMatchObject({ totalCollectedKobo: 0, paymentCount: 0 })
    })
  })
})
