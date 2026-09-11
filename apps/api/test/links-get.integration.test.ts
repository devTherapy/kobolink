import { API, ApiErrorSchema, PaymentLinkSchema } from '@kobolink/contracts'
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
