import { API, ApiErrorSchema, PaymentLinkSchema } from '@kobolink/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerCustomer, registerMerchant } from './support/register-user.js'

/** `PATCH /api/links/:code/status` — PLAN.md's B3 row. */
describe('PATCH /api/links/:code/status (real Postgres via Testcontainers)', () => {
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

  it('200: disables an active link and the response reflects it', async () => {
    const merchant = await registerMerchant(getCtx(), 'status-disable@example.test')
    const code = await createLink(merchant.cookie)

    const response = await getCtx()
      .request.patch(API.links.status(code))
      .set('Cookie', merchant.cookie)
      .send({ status: 'disabled' })

    expect(response.status).toBe(200)
    const link = PaymentLinkSchema.parse(response.body)
    expect(link.code).toBe(code)
    expect(link.status).toBe('disabled')
  })

  it('200: re-enables a disabled link', async () => {
    const merchant = await registerMerchant(getCtx(), 'status-reenable@example.test')
    const code = await createLink(merchant.cookie)
    await getCtx().request.patch(API.links.status(code)).set('Cookie', merchant.cookie).send({ status: 'disabled' })

    const response = await getCtx()
      .request.patch(API.links.status(code))
      .set('Cookie', merchant.cookie)
      .send({ status: 'active' })

    expect(response.status).toBe(200)
    expect(PaymentLinkSchema.parse(response.body).status).toBe('active')
  })

  it('400 validation_failed: an invalid status value', async () => {
    const merchant = await registerMerchant(getCtx(), 'status-validation@example.test')
    const code = await createLink(merchant.cookie)

    const response = await getCtx()
      .request.patch(API.links.status(code))
      .set('Cookie', merchant.cookie)
      .send({ status: 'not-a-real-status' })

    expect(response.status).toBe(400)
    const body = ApiErrorSchema.parse(response.body)
    expect(body.code).toBe('validation_failed')
    expect(body.fields).toHaveProperty('status')
  })

  it('404 not_found — never 403 — when a different merchant tries to change the status', async () => {
    const owner = await registerMerchant(getCtx(), 'status-owner@example.test')
    const stranger = await registerMerchant(getCtx(), 'status-stranger@example.test')
    const code = await createLink(owner.cookie)

    const response = await getCtx()
      .request.patch(API.links.status(code))
      .set('Cookie', stranger.cookie)
      .send({ status: 'disabled' })

    expect(response.status).toBe(404)
    expect(ApiErrorSchema.parse(response.body).code).toBe('not_found')

    // Untouched — the owner still sees the original status.
    const ownerView = await getCtx().request.get(API.links.item(code)).set('Cookie', owner.cookie)
    expect(PaymentLinkSchema.parse(ownerView.body).status).toBe('active')
  })

  it('404 not_found: an unknown code', async () => {
    const merchant = await registerMerchant(getCtx(), 'status-unknown@example.test')

    const response = await getCtx()
      .request.patch(API.links.status('ZZZZZZZ9'))
      .set('Cookie', merchant.cookie)
      .send({ status: 'disabled' })

    expect(response.status).toBe(404)
    expect(ApiErrorSchema.parse(response.body).code).toBe('not_found')
  })

  it('404 not_found — never 400 — for a malformed code', async () => {
    const merchant = await registerMerchant(getCtx(), 'status-malformed@example.test')

    const response = await getCtx()
      .request.patch(API.links.status('bad'))
      .set('Cookie', merchant.cookie)
      .send({ status: 'disabled' })

    expect(response.status).toBe(404)
    expect(ApiErrorSchema.parse(response.body).code).toBe('not_found')
  })

  it('401 unauthenticated: no session at all', async () => {
    const response = await getCtx().request.patch(API.links.status('ZZZZZZZ9')).send({ status: 'disabled' })
    expect(response.status).toBe(401)
    expect(ApiErrorSchema.parse(response.body).code).toBe('unauthenticated')
  })

  it('403 forbidden: an authenticated customer is not a merchant', async () => {
    const customer = await registerCustomer(getCtx(), 'status-customer@example.test')

    const response = await getCtx()
      .request.patch(API.links.status('ZZZZZZZ9'))
      .set('Cookie', customer.cookie)
      .send({ status: 'disabled' })

    expect(response.status).toBe(403)
    expect(ApiErrorSchema.parse(response.body).code).toBe('forbidden')
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
