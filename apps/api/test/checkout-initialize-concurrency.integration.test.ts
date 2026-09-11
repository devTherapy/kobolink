import { randomUUID } from 'node:crypto'
import { API, InitializeCheckoutResponseSchema, PaymentLinkSchema } from '@kobolink/contracts'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  defaultPaymentReferenceGenerator,
  PAYMENT_REFERENCE_GENERATOR,
  type PaymentReferenceGenerator,
} from '../src/payments/payment-reference.generator.js'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerMerchant } from './support/register-user.js'

/**
 * `insertCheckoutSession`'s retry loop (`payments.service.ts`) is dead code
 * unless a `checkout_sessions_pkey` collision inside the transaction can
 * actually be recovered from — see that method's own doc comment for why a
 * plain `tx.insert` can't do it (Postgres aborts the whole transaction on
 * the failing statement, `25P02`, so the loop's `continue` would retry on a
 * dead transaction). A real collision from `newPaymentReference`'s own
 * 54-symbol, 10-character alphabet is astronomically unlikely to happen on
 * its own, so — same reasoning as `links-create-collision.integration.test
 * .ts` — this file forces one directly through `PAYMENT_REFERENCE_GENERATOR`,
 * the DI seam `PaymentsService` takes its generator from, rather than
 * narrowing the real alphabet or hoping for a statistical collision. A
 * *separate* file (and container) from `checkout-initialize.integration
 * .test.ts` because only this suite needs the overridden provider.
 */
describe('POST /api/checkout/initialize — concurrent reference collision (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined
  // Consumed in order by the overridden generator; once empty, falls back
  // to a real freshly generated reference. Mutated per-test.
  const queuedReferences: string[] = []

  const stubGenerator: PaymentReferenceGenerator = () => queuedReferences.shift() ?? defaultPaymentReferenceGenerator()

  beforeAll(async () => {
    ctx = await startApiTestContext({
      configureModule: (builder) => builder.overrideProvider(PAYMENT_REFERENCE_GENERATOR).useValue(stubGenerator),
    })
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

  function payerBody(code: string, amountKobo: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { code, amountKobo, payerName: 'Chidinma Okafor', payerEmail: 'chidinma@example.test', ...overrides }
  }

  it('two concurrent initializations forced onto the same reference: one gets it, the other retries onto a fresh one instead of a raw 500', async () => {
    const merchant = await registerMerchant(getCtx(), 'init-concurrent-collision@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000, isReusable: true })

    // Both concurrent calls' first attempt is forced onto the exact same
    // reference — whichever request's insert commits first claims it, the
    // other's savepoint rolls back and the loop asks the generator again,
    // which (queue now empty) falls through to a real, fresh reference.
    const forcedReference = defaultPaymentReferenceGenerator()
    queuedReferences.push(forcedReference, forcedReference)

    const [first, second] = await Promise.all([
      getCtx().request.post(API.checkout.initialize).set('Idempotency-Key', idempotencyKey()).send(payerBody(code, 500_000)),
      getCtx()
        .request.post(API.checkout.initialize)
        .set('Idempotency-Key', idempotencyKey())
        .send(payerBody(code, 500_000, { payerEmail: 'second-racer@example.test' })),
    ])

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    const firstBody = InitializeCheckoutResponseSchema.parse(first.body)
    const secondBody = InitializeCheckoutResponseSchema.parse(second.body)

    // Genuinely two distinct checkouts, not one request silently winning
    // twice — and one of them really did land on the forced reference,
    // proving a collision actually happened and was recovered from rather
    // than just avoided by chance.
    expect(firstBody.reference).not.toBe(secondBody.reference)
    expect([firstBody.reference, secondBody.reference]).toContain(forcedReference)

    const pool = new Pool({ connectionString: getCtx().connectionString })
    try {
      const rows = await pool.query<{ count: number }>(`select count(*)::int as count from checkout_sessions where link_code = $1`, [
        code,
      ])
      expect(rows.rows[0]?.count).toBe(2)
    } finally {
      await pool.end()
    }
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
