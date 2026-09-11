import { randomUUID } from 'node:crypto'
import { API, ApiErrorSchema, InitializeCheckoutResponseSchema, PaymentLinkSchema } from '@kobolink/contracts'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerMerchant } from './support/register-user.js'

/**
 * `POST /api/checkout/initialize` — PLAN.md's B5 row. Unauthenticated by
 * design (same as `GET /api/links/:code/public`), so there is no
 * `unauthenticated`/`forbidden` case to cover here — every request in this
 * file carries no `Cookie` at all, and that is the point, not an omission.
 * The four required categories become: the happy path, the *link*-level
 * authorisation-shaped failures this endpoint actually has
 * (`link_not_payable`, `amount_mismatch` — a stranger cannot pay a link
 * that isn't payable, or for an amount the merchant didn't set), request
 * validation, and the idempotent replay.
 */
describe('POST /api/checkout/initialize (real Postgres via Testcontainers)', () => {
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

  function payerBody(code: string, amountKobo: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { code, amountKobo, payerName: 'Chidinma Okafor', payerEmail: 'chidinma@example.test', ...overrides }
  }

  it('201: a fixed-amount reusable link initializes a pending checkout with a fresh reference', async () => {
    const merchant = await registerMerchant(getCtx(), 'init-happy@example.test')
    const code = await createLink(merchant.cookie, { title: 'Consulting', amountKobo: 500_000, isReusable: true })

    const response = await getCtx()
      .request.post(API.checkout.initialize)
      .set('Idempotency-Key', idempotencyKey())
      .send(payerBody(code, 500_000))

    expect(response.status).toBe(201)
    const body = InitializeCheckoutResponseSchema.parse(response.body)
    expect(body.code).toBe(code)
    expect(body.amountKobo).toBe(500_000)
    expect(body.currency).toBe('NGN')
    expect(body.status).toBe('pending')
    expect(body.reference).toMatch(/^kbl_[2-9A-HJ-NP-Za-km-z]{10}$/)
  })

  it('201: a free-amount link accepts whatever amount the payer names', async () => {
    const merchant = await registerMerchant(getCtx(), 'init-free-amount@example.test')
    const code = await createLink(merchant.cookie, { title: 'Tip jar' })

    const response = await getCtx()
      .request.post(API.checkout.initialize)
      .set('Idempotency-Key', idempotencyKey())
      .send(payerBody(code, 750_000))

    expect(response.status).toBe(201)
    expect(InitializeCheckoutResponseSchema.parse(response.body).amountKobo).toBe(750_000)
  })

  it('400 validation_failed: no Idempotency-Key header at all', async () => {
    const merchant = await registerMerchant(getCtx(), 'init-no-key@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000 })

    const response = await getCtx().request.post(API.checkout.initialize).send(payerBody(code, 500_000))

    expect(response.status).toBe(400)
    const body = ApiErrorSchema.parse(response.body)
    expect(body.code).toBe('validation_failed')
    expect(body.moneyMoved).toBe(false)
  })

  it('400 validation_failed: a missing payerEmail', async () => {
    const merchant = await registerMerchant(getCtx(), 'init-bad-body@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000 })

    const response = await getCtx()
      .request.post(API.checkout.initialize)
      .set('Idempotency-Key', idempotencyKey())
      .send({ code, amountKobo: 500_000, payerName: 'No Email' })

    expect(response.status).toBe(400)
    expect(ApiErrorSchema.parse(response.body).code).toBe('validation_failed')
  })

  it('404 not_found: a code that was never minted', async () => {
    const response = await getCtx()
      .request.post(API.checkout.initialize)
      .set('Idempotency-Key', idempotencyKey())
      .send(payerBody('ZZZZZZZ9', 500_000))

    expect(response.status).toBe(404)
    expect(ApiErrorSchema.parse(response.body).code).toBe('not_found')
  })

  it('409 link_not_payable (state: disabled): a merchant-disabled link cannot be paid', async () => {
    const merchant = await registerMerchant(getCtx(), 'init-disabled@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000 })
    await getCtx().request.patch(API.links.status(code)).set('Cookie', merchant.cookie).send({ status: 'disabled' })

    const response = await getCtx()
      .request.post(API.checkout.initialize)
      .set('Idempotency-Key', idempotencyKey())
      .send(payerBody(code, 500_000))

    expect(response.status).toBe(409)
    const body = ApiErrorSchema.parse(response.body)
    expect(body.code).toBe('link_not_payable')
    expect(body.state).toBe('disabled')
    expect(body.moneyMoved).toBe(false)
  })

  it('409 link_not_payable (state: expired): a link past its expiresAt cannot be paid', async () => {
    const merchant = await registerMerchant(getCtx(), 'init-expired@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000, expiresAt: '2020-01-01T00:00:00.000Z' })

    const response = await getCtx()
      .request.post(API.checkout.initialize)
      .set('Idempotency-Key', idempotencyKey())
      .send(payerBody(code, 500_000))

    expect(response.status).toBe(409)
    expect(ApiErrorSchema.parse(response.body).state).toBe('expired')
  })

  it('422 amount_mismatch: a fixed-amount link rejects a different amount', async () => {
    const merchant = await registerMerchant(getCtx(), 'init-amount-mismatch@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000 })

    const response = await getCtx()
      .request.post(API.checkout.initialize)
      .set('Idempotency-Key', idempotencyKey())
      .send(payerBody(code, 500_001))

    expect(response.status).toBe(422)
    const body = ApiErrorSchema.parse(response.body)
    expect(body.code).toBe('amount_mismatch')
    expect(body.moneyMoved).toBe(false)
  })

  it('replaying the same Idempotency-Key and body is a no-op: the identical reference, not a second checkout session', async () => {
    const merchant = await registerMerchant(getCtx(), 'init-replay@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000 })
    const key = idempotencyKey()
    const body = payerBody(code, 500_000)

    const first = await getCtx().request.post(API.checkout.initialize).set('Idempotency-Key', key).send(body)
    const second = await getCtx().request.post(API.checkout.initialize).set('Idempotency-Key', key).send(body)

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.body).toEqual(first.body)

    const pool = new Pool({ connectionString: getCtx().connectionString })
    try {
      const rows = await pool.query<{ count: number }>(`select count(*)::int as count from checkout_sessions where link_code = $1`, [code])
      expect(rows.rows[0]?.count).toBe(1)
    } finally {
      await pool.end()
    }
  })

  it('422 idempotency_mismatch: the same key with a different body', async () => {
    const merchant = await registerMerchant(getCtx(), 'init-mismatch@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000 })
    const key = idempotencyKey()

    const first = await getCtx().request.post(API.checkout.initialize).set('Idempotency-Key', key).send(payerBody(code, 500_000))
    expect(first.status).toBe(201)

    const second = await getCtx()
      .request.post(API.checkout.initialize)
      .set('Idempotency-Key', key)
      .send(payerBody(code, 500_000, { payerName: 'A Different Payer' }))

    expect(second.status).toBe(422)
    expect(ApiErrorSchema.parse(second.body).code).toBe('idempotency_mismatch')
  })

  it('a client cannot forge a ledger posting through extra request fields — they are silently ignored', async () => {
    const merchant = await registerMerchant(getCtx(), 'init-forged-fields@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000 })

    const response = await getCtx()
      .request.post(API.checkout.initialize)
      .set('Idempotency-Key', idempotencyKey())
      .send({
        ...payerBody(code, 500_000),
        // None of these are fields `InitializeCheckoutRequestSchema` names —
        // a client that could reach the ledger through them would have
        // forged a posting from the public, unauthenticated checkout
        // endpoint. `ZodValidationPipe` strips unknown keys before this
        // ever reaches `PaymentsService`.
        entries: [{ accountId: 'evil_account', amountKobo: 999_999_999 }],
        ledgerAccountId: 'evil_account',
        postingId: 'forged_posting',
        moneyMoved: true,
      })

    expect(response.status).toBe(201)
    const body = InitializeCheckoutResponseSchema.parse(response.body)
    expect(body.amountKobo).toBe(500_000)

    const pool = new Pool({ connectionString: getCtx().connectionString })
    try {
      const postings = await pool.query<{ count: number }>(`select count(*)::int as count from postings`)
      // initialize never creates a posting at all — only `verify` decides
      // an outcome — so this also proves the forged fields didn't sneak one
      // in early.
      expect(postings.rows[0]?.count).toBe(0)
      const ledgerEntries = await pool.query<{ count: number }>(`select count(*)::int as count from ledger_entries`)
      expect(ledgerEntries.rows[0]?.count).toBe(0)
    } finally {
      await pool.end()
    }
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
