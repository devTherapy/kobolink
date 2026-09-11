import { randomUUID } from 'node:crypto'
import { API, ApiErrorSchema, PaymentLinkSchema, PublicLinkResponseSchema } from '@kobolink/contracts'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerMerchant } from './support/register-user.js'

/**
 * `GET /api/links/:code/public` — PLAN.md's B4 done-when: "Returns only
 * fields the checkout page renders; disabled/expired/paid resolve to the
 * right state." Every request in this file is issued with no `Cookie` at
 * all — the point of the route.
 */
describe('GET /api/links/:code/public (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined

  beforeAll(async () => {
    ctx = await startApiTestContext()
  }, 120_000)

  afterAll(async () => {
    await ctx?.teardown()
  })

  async function createLink(cookie: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const response = await getCtx()
      .request.post(API.links.collection)
      .set('Cookie', cookie)
      .send({ title: 'A link', ...overrides })
    if (response.status !== 201) throw new Error(`fixture create failed: ${response.status} ${JSON.stringify(response.body)}`)
    return PaymentLinkSchema.parse(response.body).code
  }

  /**
   * `ledger_accounts_external_funding_singleton` allows exactly one
   * `external_funding` row in the whole database — unlike
   * `merchant_receivable`, which is per merchant. This suite posts more than
   * once (the already-paid case and the reusable-stays-payable case both
   * need a completed posting), so the external account is created at most
   * once and reused, instead of each call minting its own and colliding with
   * the last.
   */
  async function getOrCreateExternalFundingAccount(pool: Pool): Promise<string> {
    const existing = await pool.query<{ id: string }>(`select id from ledger_accounts where kind = 'external_funding'`)
    if (existing.rows[0] !== undefined) return existing.rows[0].id
    const id = randomUUID()
    await pool.query(`insert into ledger_accounts (id, owner_user_id, kind) values ($1, null, 'external_funding')`, [id])
    return id
  }

  async function insertSuccessfulPosting(code: string, merchantId: string): Promise<void> {
    const pool = new Pool({ connectionString: getCtx().connectionString })
    try {
      const merchantAccountId = randomUUID()
      await pool.query(`insert into ledger_accounts (id, owner_user_id, kind) values ($1, $2, 'merchant_receivable')`, [
        merchantAccountId,
        merchantId,
      ])
      const externalAccountId = await getOrCreateExternalFundingAccount(pool)

      const client = await pool.connect()
      try {
        await client.query('begin')
        const postingId = randomUUID()
        await client.query(`insert into postings (id, kind, reference, metadata) values ($1, 'link_payment', $2, $3::jsonb)`, [
          postingId,
          `kbl_${code}`,
          JSON.stringify({ linkCode: code }),
        ])
        await client.query(
          `insert into ledger_entries (id, posting_id, account_id, amount_kobo) values
             ($1, $3, $4, 150000),
             ($2, $3, $5, -150000)`,
          [randomUUID(), randomUUID(), postingId, merchantAccountId, externalAccountId],
        )
        await client.query('commit')
      } finally {
        client.release()
      }
    } finally {
      await pool.end()
    }
  }

  it('200 payable: a fresh reusable link resolves state "payable" with only the public fields, no session required', async () => {
    const merchant = await registerMerchant(getCtx(), 'public-payable@example.test', 'Adebayo Stores')
    const code = await createLink(merchant.cookie, {
      title: 'Ankara Two-Piece Set',
      description: 'Size 12',
      amountKobo: 1_850_000,
      isReusable: true,
    })

    const response = await getCtx().request.get(API.links.resolve(code))

    expect(response.status).toBe(200)
    const body = PublicLinkResponseSchema.parse(response.body)
    expect(body.state).toBe('payable')
    expect(body.link).toEqual({
      code,
      merchantName: 'Adebayo Stores',
      title: 'Ankara Two-Piece Set',
      description: 'Size 12',
      amountKobo: 1_850_000,
      currency: 'NGN',
      isReusable: true,
      expiresAt: null,
    })
    // Byte-for-byte: no merchantId, status, paymentCount, totalPaidKobo,
    // createdAt — nothing beyond what `PublicLinkSchema` names — leaks onto
    // the wire, even though the caller has no session to have requested them.
    const rawLink = (response.body as { link: Record<string, unknown> }).link
    expect(Object.keys(rawLink).sort()).toEqual(
      ['amountKobo', 'code', 'currency', 'description', 'expiresAt', 'isReusable', 'merchantName', 'title'].sort(),
    )
  })

  it('200 disabled: a merchant-disabled link resolves state "disabled", not a 404 or 500', async () => {
    const merchant = await registerMerchant(getCtx(), 'public-disabled@example.test')
    const code = await createLink(merchant.cookie, { title: 'Turned off' })

    const disableResponse = await getCtx()
      .request.patch(API.links.status(code))
      .set('Cookie', merchant.cookie)
      .send({ status: 'disabled' })
    expect(disableResponse.status).toBe(200)

    const response = await getCtx().request.get(API.links.resolve(code))

    expect(response.status).toBe(200)
    const body = PublicLinkResponseSchema.parse(response.body)
    expect(body.state).toBe('disabled')
    expect(body.link.code).toBe(code)
  })

  it('200 expired: a link past its expiresAt resolves state "expired"', async () => {
    const merchant = await registerMerchant(getCtx(), 'public-expired@example.test')
    const code = await createLink(merchant.cookie, {
      title: 'Yesterday only',
      expiresAt: '2020-01-01T00:00:00.000Z',
    })

    const response = await getCtx().request.get(API.links.resolve(code))

    expect(response.status).toBe(200)
    const body = PublicLinkResponseSchema.parse(response.body)
    expect(body.state).toBe('expired')
    expect(body.link.expiresAt).toBe('2020-01-01T00:00:00.000Z')
  })

  it('200 already-paid: a single-use link with a completed link_payment posting resolves state "already-paid"', async () => {
    const merchant = await registerMerchant(getCtx(), 'public-paid@example.test')
    const code = await createLink(merchant.cookie, { title: 'One-time gig', isReusable: false })
    await insertSuccessfulPosting(code, merchant.userId)

    const response = await getCtx().request.get(API.links.resolve(code))

    expect(response.status).toBe(200)
    const body = PublicLinkResponseSchema.parse(response.body)
    expect(body.state).toBe('already-paid')
  })

  it('200 payable: a reusable link with a completed posting stays payable (single-use exhaustion only applies to isReusable: false)', async () => {
    const merchant = await registerMerchant(getCtx(), 'public-reusable-paid@example.test')
    const code = await createLink(merchant.cookie, { title: 'Recurring donations', isReusable: true })
    await insertSuccessfulPosting(code, merchant.userId)

    const response = await getCtx().request.get(API.links.resolve(code))

    expect(response.status).toBe(200)
    expect(PublicLinkResponseSchema.parse(response.body).state).toBe('payable')
  })

  it('404 not_found: a code that was never minted — matches the shape apps/web already expects from a 404', async () => {
    const response = await getCtx().request.get(API.links.resolve('ZZZZZZZ9'))

    expect(response.status).toBe(404)
    expect(ApiErrorSchema.parse(response.body).code).toBe('not_found')
  })

  it('404 not_found — never 400 — for a malformed code, byte-identical to the unknown-code response', async () => {
    const malformedResponse = await getCtx().request.get(API.links.resolve('not-8-chars'))
    const unknownResponse = await getCtx().request.get(API.links.resolve('ZZZZZZZ9'))

    expect(malformedResponse.status).toBe(404)
    const malformedBody = ApiErrorSchema.parse(malformedResponse.body)
    expect(malformedBody.code).toBe('not_found')
    expect(malformedBody).toEqual(ApiErrorSchema.parse(unknownResponse.body))
  })

  it('replaying the same GET is a no-op that returns the identical state (idempotent by construction — a read, not a write)', async () => {
    const merchant = await registerMerchant(getCtx(), 'public-replay@example.test')
    const code = await createLink(merchant.cookie, { title: 'Read twice' })

    const first = await getCtx().request.get(API.links.resolve(code))
    const second = await getCtx().request.get(API.links.resolve(code))

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
