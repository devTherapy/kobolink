import { randomUUID } from 'node:crypto'
import {
  API,
  ApiErrorSchema,
  InitializeCheckoutResponseSchema,
  PaymentLinkSchema,
  PaymentListResponseSchema,
} from '@kobolink/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerMerchant } from './support/register-user.js'

/**
 * `GET /api/links/:code/payments`, now that B5 has landed a real write
 * path. B3's suite (`links-payments.integration.test.ts`) already covers
 * authz/validation/pagination-shape against a link with zero payments;
 * this file is the B3 ⇄ B5 seam itself — the exact convention
 * `LinksService`'s `payments`/`computeLinkStats` read
 * (`postings.metadata ->> 'linkCode'`, a positive `merchant_receivable`
 * entry) against what `PaymentsService.verify` actually writes.
 */
describe('GET /api/links/:code/payments after real checkout activity (real Postgres via Testcontainers)', () => {
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

  async function createLink(cookie: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const response = await getCtx()
      .request.post(API.links.collection)
      .set('Cookie', cookie)
      .send({ title: 'A link', ...overrides })
    if (response.status !== 201) throw new Error(`fixture create failed: ${response.status} ${JSON.stringify(response.body)}`)
    return PaymentLinkSchema.parse(response.body).code
  }

  async function payFor(code: string, amountKobo: number, payerEmail: string): Promise<string> {
    const initResponse = await getCtx()
      .request.post(API.checkout.initialize)
      .set('Idempotency-Key', idempotencyKey())
      .send({ code, amountKobo, payerName: 'A Payer', payerEmail })
    if (initResponse.status !== 201) throw new Error(`fixture initialize failed: ${JSON.stringify(initResponse.body)}`)
    const reference = InitializeCheckoutResponseSchema.parse(initResponse.body).reference

    const verifyResponse = await getCtx()
      .request.post(API.checkout.verify)
      .set('Idempotency-Key', idempotencyKey())
      .send({ reference })
    if (verifyResponse.status !== 200) throw new Error(`fixture verify failed: ${JSON.stringify(verifyResponse.body)}`)
    return reference
  }

  it('lists a successful and a declined payment, newest first, masked email, and only the success counts toward the link totals', async () => {
    const merchant = await registerMerchant(getCtx(), 'listing-mixed@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000, isReusable: true })

    const successReference = await payFor(code, 500_000, 'ada@example.test')
    const declineReference = await payFor(code, 500_000, 'fail@example.test')

    const response = await getCtx().request.get(API.links.payments(code)).set('Cookie', merchant.cookie)

    expect(response.status).toBe(200)
    const page = PaymentListResponseSchema.parse(response.body)
    expect(page.items.map((p) => p.reference)).toEqual([declineReference, successReference])

    const [decline, success] = page.items
    expect(success?.status).toBe('success')
    expect(success?.moneyMoved).toBe(true)
    expect(success?.payerEmail).toBe('a***@example.test')
    expect(decline?.status).toBe('failed')
    expect(decline?.moneyMoved).toBe(false)
    expect(decline?.failureReason).toBe('Card declined by the simulated gateway.')

    const linkResponse = await getCtx().request.get(API.links.item(code)).set('Cookie', merchant.cookie)
    const link = PaymentLinkSchema.parse(linkResponse.body)
    expect(link.paymentCount).toBe(1)
    expect(link.totalPaidKobo).toBe(500_000)
  })

  it('a payment against another merchant\'s link never appears in this merchant\'s dashboard.stats-adjacent totals — 404, not a leaked list', async () => {
    const owner = await registerMerchant(getCtx(), 'listing-owner@example.test')
    const stranger = await registerMerchant(getCtx(), 'listing-stranger@example.test')
    const code = await createLink(owner.cookie, { amountKobo: 500_000, isReusable: true })
    await payFor(code, 500_000, 'ada@example.test')

    const response = await getCtx().request.get(API.links.payments(code)).set('Cookie', stranger.cookie)

    expect(response.status).toBe(404)
    expect(ApiErrorSchema.parse(response.body).code).toBe('not_found')
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
