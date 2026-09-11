import { randomUUID } from 'node:crypto'
import { API, ApiErrorSchema, PaymentLinkSchema } from '@kobolink/contracts'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerCustomer, registerMerchant } from './support/register-user.js'

/**
 * `GET /api/links/:code` — PLAN.md's B3 done-when in full: "A link created
 * via the API is readable by code; a second merchant gets 404, not 403."
 * `packages/contracts/README.md`'s own rule for this route: existence is
 * never disclosed to a merchant who doesn't own the link — a wrong-merchant
 * code and a code nobody ever minted must be byte-identical on the wire.
 */
describe('GET /api/links/:code (real Postgres via Testcontainers)', () => {
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

  it('200: the owning merchant reads back exactly what they created', async () => {
    const merchant = await registerMerchant(getCtx(), 'get-owner@example.test', 'Adebayo Stores')
    const code = await createLink(merchant.cookie, { title: 'Consulting session', amountKobo: 500_000 })

    const response = await getCtx().request.get(API.links.item(code)).set('Cookie', merchant.cookie)

    expect(response.status).toBe(200)
    const link = PaymentLinkSchema.parse(response.body)
    expect(link.code).toBe(code)
    expect(link.title).toBe('Consulting session')
    expect(link.amountKobo).toBe(500_000)
    expect(link.merchantName).toBe('Adebayo Stores')
  })

  it('a disabled link is still readable by its owning merchant, with status "disabled"', async () => {
    const merchant = await registerMerchant(getCtx(), 'get-disabled@example.test')
    const code = await createLink(merchant.cookie)

    const disableResponse = await getCtx()
      .request.patch(API.links.status(code))
      .set('Cookie', merchant.cookie)
      .send({ status: 'disabled' })
    expect(disableResponse.status).toBe(200)

    const response = await getCtx().request.get(API.links.item(code)).set('Cookie', merchant.cookie)
    expect(response.status).toBe(200)
    expect(PaymentLinkSchema.parse(response.body).status).toBe('disabled')
  })

  it(
    'paymentCount/totalPaidKobo reflect a real balanced link_payment posting ' +
      "(pins the postings.metadata->>'linkCode' convention LinksService.computeLinkStatsBatch depends on)",
    async () => {
      const merchant = await registerMerchant(getCtx(), 'get-stats@example.test')
      const code = await createLink(merchant.cookie, { title: 'Paid link' })

      // `LinksService.computeLinkStatsBatch`'s own doc comment: a
      // `link_payment` posting's credit side against the merchant's
      // `merchant_receivable` account is what counts. Every current test
      // gets `0`/`0` from `ZERO_STATS` regardless of whether that query
      // body is right — this writes a real, balanced posting directly (B5
      // hasn't landed, so nothing else ever will) to pin the convention in
      // code, not only in the doc comment.
      //
      // The posting and its entries are inserted through one client inside
      // one transaction — `drizzle/0003_ledger_entries_posting_same_transaction.sql`'s
      // trigger rejects `ledger_entries` rows against a posting that wasn't
      // created in that same transaction (see `ledger-entries-same-transaction.integration.test.ts`),
      // exactly like B5's own real write path would.
      const pool = new Pool({ connectionString: getCtx().connectionString })
      try {
        const merchantAccountId = randomUUID()
        await pool.query(`insert into ledger_accounts (id, owner_user_id, kind) values ($1, $2, 'merchant_receivable')`, [
          merchantAccountId,
          merchant.userId,
        ])
        const externalAccountId = randomUUID()
        await pool.query(`insert into ledger_accounts (id, owner_user_id, kind) values ($1, null, 'external_funding')`, [
          externalAccountId,
        ])

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

      const response = await getCtx().request.get(API.links.item(code)).set('Cookie', merchant.cookie)

      expect(response.status).toBe(200)
      const link = PaymentLinkSchema.parse(response.body)
      expect(link.paymentCount).toBe(1)
      expect(link.totalPaidKobo).toBe(150_000)
    },
  )

  it('404 not_found: a code that was never minted', async () => {
    const merchant = await registerMerchant(getCtx(), 'get-unknown@example.test')

    const response = await getCtx().request.get(API.links.item('ZZZZZZZ9')).set('Cookie', merchant.cookie)

    expect(response.status).toBe(404)
    expect(ApiErrorSchema.parse(response.body).code).toBe('not_found')
  })

  it('404 not_found — never 403 — for a link that belongs to a different merchant, byte-identical to the unknown-code response', async () => {
    const owner = await registerMerchant(getCtx(), 'get-owner-b@example.test')
    const stranger = await registerMerchant(getCtx(), 'get-stranger@example.test')
    const code = await createLink(owner.cookie, { title: "Owner's link" })

    const strangerResponse = await getCtx().request.get(API.links.item(code)).set('Cookie', stranger.cookie)
    const unknownResponse = await getCtx().request.get(API.links.item('ZZZZZZZ9')).set('Cookie', stranger.cookie)

    expect(strangerResponse.status).toBe(404)
    const strangerBody = ApiErrorSchema.parse(strangerResponse.body)
    expect(strangerBody.code).toBe('not_found')
    expect(strangerBody).toEqual(ApiErrorSchema.parse(unknownResponse.body))
  })

  it('404 not_found — never 400 — for a malformed code, identical to the unknown-code response', async () => {
    const merchant = await registerMerchant(getCtx(), 'get-malformed@example.test')

    const malformedResponse = await getCtx().request.get(API.links.item('not-8-chars')).set('Cookie', merchant.cookie)
    const unknownResponse = await getCtx().request.get(API.links.item('ZZZZZZZ9')).set('Cookie', merchant.cookie)

    expect(malformedResponse.status).toBe(404)
    const malformedBody = ApiErrorSchema.parse(malformedResponse.body)
    expect(malformedBody.code).toBe('not_found')
    expect(malformedBody).toEqual(ApiErrorSchema.parse(unknownResponse.body))
  })

  it('401 unauthenticated: no session at all', async () => {
    const response = await getCtx().request.get(API.links.item('ZZZZZZZ9'))
    expect(response.status).toBe(401)
    expect(ApiErrorSchema.parse(response.body).code).toBe('unauthenticated')
  })

  it('403 forbidden: an authenticated customer is not a merchant', async () => {
    const customer = await registerCustomer(getCtx(), 'get-customer@example.test')

    const response = await getCtx().request.get(API.links.item('ZZZZZZZ9')).set('Cookie', customer.cookie)

    expect(response.status).toBe(403)
    expect(ApiErrorSchema.parse(response.body).code).toBe('forbidden')
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
