import { API, ApiErrorSchema, PaymentLinkSchema, PaymentListResponseSchema } from '@kobolink/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerCustomer, registerMerchant } from './support/register-user.js'

/**
 * `GET /api/links/:code/payments` — PLAN.md's B3 row: shape, authz and
 * merchant-scoping, exercised here against a link that has never been paid
 * (so a correctly-shaped **empty** page is still the right answer). B5 has
 * since landed the real write path (`checkout.initialize`/`checkout.verify`)
 * and its own read-side coverage — a link with a mix of successful and
 * declined payments — lives in
 * `checkout-payments-listing.integration.test.ts`.
 */
describe('GET /api/links/:code/payments (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined

  beforeAll(async () => {
    ctx = await startApiTestContext()
  }, 120_000)

  afterAll(async () => {
    await ctx?.teardown()
  })

  async function createLink(cookie: string): Promise<string> {
    const response = await getCtx().request.post(API.links.collection).set('Cookie', cookie).send({ title: 'A link' })
    if (response.status !== 201) throw new Error(`fixture create failed: ${response.status} ${JSON.stringify(response.body)}`)
    return PaymentLinkSchema.parse(response.body).code
  }

  it('200: a correctly shaped, empty page for a link with no payments yet (no B5 postings exist at all)', async () => {
    const merchant = await registerMerchant(getCtx(), 'payments-empty@example.test')
    const code = await createLink(merchant.cookie)

    const response = await getCtx().request.get(API.links.payments(code)).set('Cookie', merchant.cookie)

    expect(response.status).toBe(200)
    const page = PaymentListResponseSchema.parse(response.body)
    expect(page.items).toEqual([])
    expect(page.nextCursor).toBeNull()
  })

  it('404 not_found: an unknown code', async () => {
    const merchant = await registerMerchant(getCtx(), 'payments-unknown@example.test')

    const response = await getCtx().request.get(API.links.payments('ZZZZZZZ9')).set('Cookie', merchant.cookie)

    expect(response.status).toBe(404)
    expect(ApiErrorSchema.parse(response.body).code).toBe('not_found')
  })

  it('404 not_found: a malformed code', async () => {
    const merchant = await registerMerchant(getCtx(), 'payments-malformed@example.test')

    const response = await getCtx().request.get(API.links.payments('bad')).set('Cookie', merchant.cookie)

    expect(response.status).toBe(404)
    expect(ApiErrorSchema.parse(response.body).code).toBe('not_found')
  })

  it('404 not_found — never 403 — for a link that belongs to a different merchant', async () => {
    const owner = await registerMerchant(getCtx(), 'payments-owner@example.test')
    const stranger = await registerMerchant(getCtx(), 'payments-stranger@example.test')
    const code = await createLink(owner.cookie)

    const response = await getCtx().request.get(API.links.payments(code)).set('Cookie', stranger.cookie)

    expect(response.status).toBe(404)
    expect(ApiErrorSchema.parse(response.body).code).toBe('not_found')
  })

  it('400 validation_failed: a garbage cursor — same as GET /api/links, even though this route\'s page is still always empty', async () => {
    const merchant = await registerMerchant(getCtx(), 'payments-bad-cursor@example.test')
    const code = await createLink(merchant.cookie)

    const response = await getCtx()
      .request.get(API.links.payments(code))
      .query({ cursor: 'not-a-real-cursor' })
      .set('Cookie', merchant.cookie)

    expect(response.status).toBe(400)
    const body = ApiErrorSchema.parse(response.body)
    expect(body.code).toBe('validation_failed')
    expect(body.fields).toHaveProperty('cursor')
  })

  it('400 validation_failed: limit above PageQuerySchema\'s max', async () => {
    const merchant = await registerMerchant(getCtx(), 'payments-validation@example.test')
    const code = await createLink(merchant.cookie)

    const response = await getCtx()
      .request.get(API.links.payments(code))
      .query({ limit: 101 })
      .set('Cookie', merchant.cookie)

    expect(response.status).toBe(400)
    expect(ApiErrorSchema.parse(response.body).code).toBe('validation_failed')
  })

  it('401 unauthenticated: no session at all', async () => {
    const response = await getCtx().request.get(API.links.payments('ZZZZZZZ9'))
    expect(response.status).toBe(401)
    expect(ApiErrorSchema.parse(response.body).code).toBe('unauthenticated')
  })

  it('403 forbidden: an authenticated customer is not a merchant', async () => {
    const customer = await registerCustomer(getCtx(), 'payments-customer@example.test')

    const response = await getCtx().request.get(API.links.payments('ZZZZZZZ9')).set('Cookie', customer.cookie)

    expect(response.status).toBe(403)
    expect(ApiErrorSchema.parse(response.body).code).toBe('forbidden')
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
