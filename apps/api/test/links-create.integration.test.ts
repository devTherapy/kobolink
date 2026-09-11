import { API, ApiErrorSchema, PaymentLinkSchema } from '@kobolink/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerCustomer, registerMerchant } from './support/register-user.js'

/**
 * `POST /api/links` — PLAN.md's B3 row. Happy path (full body and
 * defaults-applied minimal body), validation failure, and the two authz
 * failures (`SessionGuard`/`MerchantGuard`, composed the same way B3's own
 * brief and `merchant-guard.integration.test.ts` already establish). The
 * collision-retry scenario needs its own overridden `LINK_CODE_GENERATOR`
 * provider and lives in `links-create-collision.integration.test.ts`.
 */
describe('POST /api/links (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined

  beforeAll(async () => {
    ctx = await startApiTestContext()
  }, 120_000)

  afterAll(async () => {
    await ctx?.teardown()
  })

  it('201: a full body round-trips as a PaymentLink with a fresh 8-character code and zeroed counters', async () => {
    const merchant = await registerMerchant(getCtx(), 'create-happy@example.test', 'Adebayo Stores')

    const response = await getCtx()
      .request.post(API.links.collection)
      .set('Cookie', merchant.cookie)
      .send({
        title: 'Consulting session',
        description: 'One hour, paid up front.',
        amountKobo: 500_000,
        isReusable: true,
        expiresAt: '2030-01-01T00:00:00.000Z',
      })

    expect(response.status).toBe(201)
    const link = PaymentLinkSchema.parse(response.body)
    expect(link.code).toHaveLength(8)
    expect(link.merchantId).toBe(merchant.userId)
    expect(link.merchantName).toBe('Adebayo Stores')
    expect(link.title).toBe('Consulting session')
    expect(link.description).toBe('One hour, paid up front.')
    expect(link.amountKobo).toBe(500_000)
    expect(link.currency).toBe('NGN')
    expect(link.status).toBe('active')
    expect(link.isReusable).toBe(true)
    expect(link.expiresAt).toBe('2030-01-01T00:00:00.000Z')
    expect(link.paymentCount).toBe(0)
    expect(link.totalPaidKobo).toBe(0)
  })

  it('201: a minimal body applies CreateLinkRequestSchema defaults — null description, null amountKobo, isReusable false, null expiresAt', async () => {
    const merchant = await registerMerchant(getCtx(), 'create-minimal@example.test')

    const response = await getCtx()
      .request.post(API.links.collection)
      .set('Cookie', merchant.cookie)
      .send({ title: 'Support this stall' })

    expect(response.status).toBe(201)
    const link = PaymentLinkSchema.parse(response.body)
    expect(link.title).toBe('Support this stall')
    expect(link.description).toBeNull()
    expect(link.amountKobo).toBeNull()
    expect(link.isReusable).toBe(false)
    expect(link.expiresAt).toBeNull()
  })

  it('the client cannot supply its own code — an extra "code" field is silently ignored, not honoured', async () => {
    const merchant = await registerMerchant(getCtx(), 'create-no-client-code@example.test')

    const response = await getCtx()
      .request.post(API.links.collection)
      .set('Cookie', merchant.cookie)
      .send({ title: 'Attempted forgery', code: 'HACKEDXX' })

    expect(response.status).toBe(201)
    const link = PaymentLinkSchema.parse(response.body)
    expect(link.code).not.toBe('HACKEDXX')
  })

  it('400 validation_failed: a missing title is rejected with a field-keyed message', async () => {
    const merchant = await registerMerchant(getCtx(), 'create-validation@example.test')

    const response = await getCtx().request.post(API.links.collection).set('Cookie', merchant.cookie).send({})

    expect(response.status).toBe(400)
    const body = ApiErrorSchema.parse(response.body)
    expect(body.code).toBe('validation_failed')
    expect(body.fields).toHaveProperty('title')
  })

  it('400 validation_failed: a zero amountKobo is rejected (AmountKoboSchema has a floor)', async () => {
    const merchant = await registerMerchant(getCtx(), 'create-validation-amount@example.test')

    const response = await getCtx()
      .request.post(API.links.collection)
      .set('Cookie', merchant.cookie)
      .send({ title: 'Bad amount', amountKobo: 0 })

    expect(response.status).toBe(400)
    expect(ApiErrorSchema.parse(response.body).code).toBe('validation_failed')
  })

  it('401 unauthenticated: no session at all', async () => {
    const response = await getCtx().request.post(API.links.collection).send({ title: 'No session' })
    expect(response.status).toBe(401)
    expect(ApiErrorSchema.parse(response.body).code).toBe('unauthenticated')
  })

  it('403 forbidden: an authenticated customer is not a merchant', async () => {
    const customer = await registerCustomer(getCtx(), 'create-customer@example.test')

    const response = await getCtx()
      .request.post(API.links.collection)
      .set('Cookie', customer.cookie)
      .send({ title: 'Customers cannot create links' })

    expect(response.status).toBe(403)
    expect(ApiErrorSchema.parse(response.body).code).toBe('forbidden')
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
