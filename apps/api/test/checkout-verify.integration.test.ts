import { randomUUID } from 'node:crypto'
import {
  API,
  ApiErrorSchema,
  InitializeCheckoutResponseSchema,
  PaymentLinkSchema,
  VerifyCheckoutResponseSchema,
} from '@kobolink/contracts'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerMerchant } from './support/register-user.js'

/**
 * `POST /api/checkout/verify` — PLAN.md's B5 row, the endpoint that
 * actually decides a payment and (on success) posts the ledger entries.
 * Unauthenticated by design, same as `checkout-initialize.integration.test
 * .ts` — no `Cookie` on any request here either.
 *
 * "Entries balance to zero" and "a client cannot forge a posting" are
 * proven directly against the database in the tests that need them, not
 * asserted once in the abstract — the happy-path test itself sums
 * `ledger_entries` for the posting it just created.
 */
describe('POST /api/checkout/verify (real Postgres via Testcontainers)', () => {
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

  async function initialize(code: string, amountKobo: number, payerEmail = 'chidinma@example.test'): Promise<string> {
    const response = await getCtx()
      .request.post(API.checkout.initialize)
      .set('Idempotency-Key', idempotencyKey())
      .send({ code, amountKobo, payerName: 'Chidinma Okafor', payerEmail })
    if (response.status !== 201) throw new Error(`fixture initialize failed: ${response.status} ${JSON.stringify(response.body)}`)
    return InitializeCheckoutResponseSchema.parse(response.body).reference
  }

  function verify(reference: string, key = idempotencyKey()) {
    return getCtx().request.post(API.checkout.verify).set('Idempotency-Key', key).send({ reference })
  }

  function pool(): Pool {
    return new Pool({ connectionString: getCtx().connectionString })
  }

  it('200 success: posts two balanced ledger entries (merchant_receivable credited, external_funding debited) and updates the link counters', async () => {
    const merchant = await registerMerchant(getCtx(), 'verify-happy@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000, isReusable: true })
    const reference = await initialize(code, 500_000)

    const response = await verify(reference)

    expect(response.status).toBe(200)
    const body = VerifyCheckoutResponseSchema.parse(response.body)
    expect(body.payment.reference).toBe(reference)
    expect(body.payment.status).toBe('success')
    expect(body.payment.moneyMoved).toBe(true)
    expect(body.payment.failureReason).toBeNull()
    expect(body.payment.amountKobo).toBe(500_000)
    expect(body.payment.completedAt).not.toBeNull()
    // The email is masked, never the raw address, even to the payer's own result screen.
    expect(body.payment.payerEmail).toBe('c***@example.test')

    const db = pool()
    try {
      const postings = await db.query<{ id: string; kind: string }>(`select id, kind from postings where reference = $1`, [
        reference,
      ])
      expect(postings.rows).toHaveLength(1)
      expect(postings.rows[0]?.kind).toBe('link_payment')
      const postingId = postings.rows[0]?.id

      const entries = await db.query<{ amount_kobo: string; kind: string }>(
        `select e.amount_kobo, a.kind
         from ledger_entries e
         join ledger_accounts a on a.id = e.account_id
         where e.posting_id = $1`,
        [postingId],
      )
      expect(entries.rows).toHaveLength(2)
      const sum = entries.rows.reduce((total, row) => total + Number(row.amount_kobo), 0)
      expect(sum).toBe(0)
      const byKind = new Map(entries.rows.map((row) => [row.kind, Number(row.amount_kobo)]))
      expect(byKind.get('merchant_receivable')).toBe(500_000)
      expect(byKind.get('external_funding')).toBe(-500_000)
    } finally {
      await db.end()
    }

    const linkResponse = await getCtx().request.get(API.links.item(code)).set('Cookie', merchant.cookie)
    const link = PaymentLinkSchema.parse(linkResponse.body)
    expect(link.paymentCount).toBe(1)
    expect(link.totalPaidKobo).toBe(500_000)
  })

  it('200 failed (simulated decline): a payerEmail starting fail@ declines — 200, not an error, and moves no money', async () => {
    const merchant = await registerMerchant(getCtx(), 'verify-decline@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000, isReusable: true })
    const reference = await initialize(code, 500_000, 'fail@example.test')

    const response = await verify(reference)

    expect(response.status).toBe(200)
    const body = VerifyCheckoutResponseSchema.parse(response.body)
    expect(body.payment.status).toBe('failed')
    expect(body.payment.moneyMoved).toBe(false)
    expect(body.payment.failureReason).toBe('Card declined by the simulated gateway.')

    const db = pool()
    try {
      const postings = await db.query<{ id: string }>(`select id from postings where reference = $1`, [reference])
      expect(postings.rows).toHaveLength(1)
      const entries = await db.query(`select 1 from ledger_entries where posting_id = $1`, [postings.rows[0]?.id])
      // A decline moves no money at all — not a reversing pair, no entries whatsoever.
      expect(entries.rows).toHaveLength(0)
    } finally {
      await db.end()
    }

    const linkResponse = await getCtx().request.get(API.links.item(code)).set('Cookie', merchant.cookie)
    const link = PaymentLinkSchema.parse(linkResponse.body)
    expect(link.paymentCount).toBe(0)
    expect(link.totalPaidKobo).toBe(0)
  })

  it('200 failed: a single-use link already paid by a racing checkout resolves the second attempt as failed, never a second posting that moves money', async () => {
    const merchant = await registerMerchant(getCtx(), 'verify-already-paid@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000, isReusable: false })

    // Both checkouts are *initialized* while the link is still fresh
    // (`paymentCount === 0`) — modelling two payers racing for the same
    // single-use link — and only then verified in order, so the decision
    // (not just the initialize-time check) is what has to catch the second
    // one: `decideVerify` re-resolves the link, under a row lock, at the
    // moment it is about to decide, never trusting whatever it looked like
    // back at `initialize` time.
    const firstReference = await initialize(code, 500_000)
    const secondReference = await initialize(code, 500_000, 'second@example.test')

    const firstVerify = await verify(firstReference)
    expect(VerifyCheckoutResponseSchema.parse(firstVerify.body).payment.status).toBe('success')

    const secondVerify = await verify(secondReference)

    expect(secondVerify.status).toBe(200)
    const body = VerifyCheckoutResponseSchema.parse(secondVerify.body)
    expect(body.payment.status).toBe('failed')
    expect(body.payment.moneyMoved).toBe(false)
    expect(body.payment.failureReason).toBe('Link is already paid')

    const linkResponse = await getCtx().request.get(API.links.item(code)).set('Cookie', merchant.cookie)
    const link = PaymentLinkSchema.parse(linkResponse.body)
    expect(link.paymentCount).toBe(1)
    expect(link.totalPaidKobo).toBe(500_000)
  })

  it('404 not_found: a reference nothing ever initialized', async () => {
    const response = await verify('kbl_2A3b4C5d6E')
    expect(response.status).toBe(404)
    expect(ApiErrorSchema.parse(response.body).code).toBe('not_found')
  })

  it('400 validation_failed: no Idempotency-Key header', async () => {
    const merchant = await registerMerchant(getCtx(), 'verify-no-key@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000 })
    const reference = await initialize(code, 500_000)

    const response = await getCtx().request.post(API.checkout.verify).send({ reference })

    expect(response.status).toBe(400)
    const body = ApiErrorSchema.parse(response.body)
    expect(body.code).toBe('validation_failed')
    expect(body.moneyMoved).toBe(false)
  })

  it('replaying the same Idempotency-Key is a no-op: identical response, still exactly one posting', async () => {
    const merchant = await registerMerchant(getCtx(), 'verify-replay-same-key@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000, isReusable: true })
    const reference = await initialize(code, 500_000)
    const key = idempotencyKey()

    const first = await verify(reference, key)
    const second = await verify(reference, key)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)

    const db = pool()
    try {
      const postings = await db.query<{ count: number }>(`select count(*)::int as count from postings where reference = $1`, [reference])
      expect(postings.rows[0]?.count).toBe(1)
    } finally {
      await db.end()
    }
  })

  it('verifying the same reference again under a *different* Idempotency-Key still returns the original decision — a reference is decided once', async () => {
    const merchant = await registerMerchant(getCtx(), 'verify-replay-diff-key@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000, isReusable: true })
    const reference = await initialize(code, 500_000)

    const first = await verify(reference, idempotencyKey())
    const second = await verify(reference, idempotencyKey())

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)

    const db = pool()
    try {
      const postings = await db.query<{ count: number }>(`select count(*)::int as count from postings where reference = $1`, [reference])
      expect(postings.rows[0]?.count).toBe(1)
      const linkResponse = await getCtx().request.get(API.links.item(code)).set('Cookie', merchant.cookie)
      expect(PaymentLinkSchema.parse(linkResponse.body).paymentCount).toBe(1)
    } finally {
      await db.end()
    }
  })

  it('a client cannot forge a ledger posting: extra reference-adjacent fields in the body are ignored, the amount is always what initialize resolved', async () => {
    const merchant = await registerMerchant(getCtx(), 'verify-forged-fields@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000, isReusable: true })
    const reference = await initialize(code, 500_000)

    const response = await getCtx()
      .request.post(API.checkout.verify)
      .set('Idempotency-Key', idempotencyKey())
      .send({
        reference,
        // `VerifyCheckoutRequestSchema` names only `reference` — none of
        // these reach `PaymentsService`, which decides the amount and the
        // accounts purely from server-side state (`checkout_sessions`,
        // resolved at `initialize` time).
        amountKobo: 999_999_999,
        entries: [{ accountId: 'evil_account', amountKobo: 999_999_999 }],
        accountId: 'evil_account',
      })

    expect(response.status).toBe(200)
    const body = VerifyCheckoutResponseSchema.parse(response.body)
    expect(body.payment.amountKobo).toBe(500_000)

    const db = pool()
    try {
      const entries = await db.query<{ amount_kobo: string }>(
        `select e.amount_kobo from ledger_entries e join postings p on p.id = e.posting_id where p.reference = $1`,
        [reference],
      )
      const amounts = entries.rows.map((row) => Number(row.amount_kobo)).sort((a, b) => a - b)
      expect(amounts).toEqual([-500_000, 500_000])
    } finally {
      await db.end()
    }
  })

  it('concurrent first-time payments across 8 distinct links/merchants: getOrCreateAccount race never surfaces as a 500 — all succeed with exactly one balanced posting each', async () => {
    // Every one of these is the *first ever* payment for its own merchant,
    // and all 8 additionally race to create the singleton `external_funding`
    // account (there is only ever one, across every merchant) — the exact
    // shape of the race `getOrCreateAccount` has to recover from. Firing
    // these with `Promise.all`, not sequential `await`s, is what actually
    // exercises the race: sequential calls never see a concurrent insert.
    const LINK_COUNT = 8
    const references: string[] = []
    const merchantIds: string[] = []
    for (let i = 0; i < LINK_COUNT; i++) {
      const merchant = await registerMerchant(getCtx(), `verify-concurrent-accounts-${i}@example.test`)
      merchantIds.push(merchant.userId)
      const code = await createLink(merchant.cookie, { amountKobo: 500_000, isReusable: true })
      references.push(await initialize(code, 500_000, `payer-${i}@example.test`))
    }

    const responses = await Promise.all(references.map((reference) => verify(reference)))

    for (const response of responses) {
      expect(response.status).toBe(200)
      const body = VerifyCheckoutResponseSchema.parse(response.body)
      expect(body.payment.status).toBe('success')
      expect(body.payment.moneyMoved).toBe(true)
    }

    const db = pool()
    try {
      // Exactly one `external_funding` row ever exists, no matter how many
      // transactions raced to create it — the losers recovered the
      // winner's row instead of erroring (or, pre-fix, instead of leaving
      // one race unrecovered and duplicating the singleton).
      const externalAccounts = await db.query<{ count: number }>(
        `select count(*)::int as count from ledger_accounts where kind = 'external_funding'`,
      )
      expect(externalAccounts.rows[0]?.count).toBe(1)

      // Scoped to *this test's* merchants — earlier tests in this file
      // create their own `merchant_receivable` rows too, so a bare, unscoped
      // count here would be a false negative against the rest of the suite,
      // not a real assertion about this race.
      const merchantAccounts = await db.query<{ count: number }>(
        `select count(*)::int as count from ledger_accounts where kind = 'merchant_receivable' and owner_user_id = any($1::text[])`,
        [merchantIds],
      )
      expect(merchantAccounts.rows[0]?.count).toBe(LINK_COUNT)

      for (const reference of references) {
        const entries = await db.query<{ amount_kobo: string }>(
          `select e.amount_kobo from ledger_entries e join postings p on p.id = e.posting_id where p.reference = $1`,
          [reference],
        )
        expect(entries.rows).toHaveLength(2)
        const sum = entries.rows.reduce((total, row) => total + Number(row.amount_kobo), 0)
        expect(sum).toBe(0)
      }
    } finally {
      await db.end()
    }
  })

  it('concurrent verify calls reusing the same Idempotency-Key for two different references on the same link: one succeeds, the other is a clean idempotency_mismatch, never a raw 500', async () => {
    const merchant = await registerMerchant(getCtx(), 'verify-concurrent-idem-race@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000, isReusable: true })
    const firstReference = await initialize(code, 500_000, 'racer-one@example.test')
    const secondReference = await initialize(code, 500_000, 'racer-two@example.test')
    const key = idempotencyKey()

    // Both calls pass `IdempotencyService.lookup` before either has
    // committed (no row exists yet for `key`), lock two *different*
    // `checkout_sessions` rows — so the `FOR UPDATE` above never serialises
    // them — and then race the `postings` insert on the same
    // `(idempotencyScope, idempotencyKey)`. Fired with `Promise.all`, not
    // sequential `await`s, so the race is real.
    const [first, second] = await Promise.all([verify(firstReference, key), verify(secondReference, key)])

    const statuses = [first.status, second.status].sort((a, b) => a - b)
    expect(statuses).toEqual([200, 422])

    const success = first.status === 200 ? first : second
    const mismatch = first.status === 422 ? first : second
    const successBody = VerifyCheckoutResponseSchema.parse(success.body)
    expect(successBody.payment.status).toBe('success')
    expect(successBody.payment.moneyMoved).toBe(true)
    expect(ApiErrorSchema.parse(mismatch.body).code).toBe('idempotency_mismatch')

    const db = pool()
    try {
      // Only the winner's posting survives — the loser's transaction rolled
      // back in full, including its own `checkout_sessions` claim, so it
      // never left a half-decided reference behind either.
      const postings = await db.query<{ count: number }>(`select count(*)::int as count from postings where idempotency_key = $1`, [
        key,
      ])
      expect(postings.rows[0]?.count).toBe(1)
      const idempotencyRows = await db.query<{ count: number }>(`select count(*)::int as count from idempotency_keys where key = $1`, [
        key,
      ])
      expect(idempotencyRows.rows[0]?.count).toBe(1)
    } finally {
      await db.end()
    }
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
