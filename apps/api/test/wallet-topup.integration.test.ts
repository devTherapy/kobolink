import { randomUUID } from 'node:crypto'
import { API, ApiErrorSchema, TransferResponseSchema, WalletSchema } from '@kobolink/contracts'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerCustomer } from './support/register-user.js'

/**
 * `POST /api/wallet/topup` — PLAN.md's B8 row. Simulated funding: credits
 * the caller's own wallet, debits the `external_funding` singleton
 * (reused from B5 — same account kind, same reasoning: "a funding account
 * always is [signed negative]", `db/schema/ledger-accounts.ts`'s own doc
 * comment). No balance check — an unlimited source never refuses.
 */
describe('POST /api/wallet/topup (real Postgres via Testcontainers)', () => {
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

  function topup(cookie: string, amountKobo: number, key = idempotencyKey()) {
    return getCtx().request.post(API.wallet.topup).set('Cookie', cookie).set('Idempotency-Key', key).send({ amountKobo })
  }

  it('401s with no session at all', async () => {
    const response = await getCtx().request.post(API.wallet.topup).set('Idempotency-Key', idempotencyKey()).send({ amountKobo: 50_000 })
    expect(response.status).toBe(401)
    expect(ApiErrorSchema.parse(response.body).code).toBe('unauthenticated')
  })

  it('400s with no Idempotency-Key header', async () => {
    const user = await registerCustomer(getCtx(), 'topup-no-key@example.test')
    const response = await getCtx().request.post(API.wallet.topup).set('Cookie', user.cookie).send({ amountKobo: 50_000 })
    expect(response.status).toBe(400)
    expect(ApiErrorSchema.parse(response.body).code).toBe('validation_failed')
  })

  it('400s on a validation failure (amount below the minimum chargeable amount)', async () => {
    const user = await registerCustomer(getCtx(), 'topup-bad-amount@example.test')
    const response = await topup(user.cookie, 1)
    expect(response.status).toBe(400)
    expect(ApiErrorSchema.parse(response.body).code).toBe('validation_failed')
  })

  it('201: credits the wallet, debits external_funding, entries balance to zero, balance reflects the credit', async () => {
    const user = await registerCustomer(getCtx(), 'topup-happy@example.test')

    const response = await topup(user.cookie, 250_000)

    expect(response.status).toBe(201)
    const body = TransferResponseSchema.parse(response.body)
    expect(body.transaction.kind).toBe('topup')
    expect(body.transaction.amountKobo).toBe(250_000)
    expect(body.transaction.counterparty).toBeNull()
    expect(body.wallet.balanceKobo).toBe(250_000)

    const pool = new Pool({ connectionString: getCtx().connectionString })
    try {
      const entries = await pool.query<{ amount_kobo: string; kind: string }>(
        `select e.amount_kobo, a.kind
         from ledger_entries e
         join postings p on p.id = e.posting_id
         join ledger_accounts a on a.id = e.account_id
         where p.id = $1`,
        [body.transaction.postingId],
      )
      expect(entries.rows).toHaveLength(2)
      expect(entries.rows.reduce((total, row) => total + Number(row.amount_kobo), 0)).toBe(0)
      const walletLeg = entries.rows.find((row) => row.kind === 'wallet')
      const externalLeg = entries.rows.find((row) => row.kind === 'external_funding')
      expect(Number(walletLeg?.amount_kobo)).toBe(250_000)
      expect(Number(externalLeg?.amount_kobo)).toBe(-250_000)
    } finally {
      await pool.end()
    }
  })

  it('a second top-up accumulates onto the balance', async () => {
    const user = await registerCustomer(getCtx(), 'topup-accumulate@example.test')
    await topup(user.cookie, 100_000)
    const second = await topup(user.cookie, 75_000)

    expect(second.status).toBe(201)
    expect(TransferResponseSchema.parse(second.body).wallet.balanceKobo).toBe(175_000)
  })

  it('replaying the same Idempotency-Key is a no-op: identical response, no second posting', async () => {
    const user = await registerCustomer(getCtx(), 'topup-idempotent@example.test')
    const key = idempotencyKey()

    const first = await topup(user.cookie, 60_000, key)
    const second = await topup(user.cookie, 60_000, key)

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.body).toEqual(first.body)

    const pool = new Pool({ connectionString: getCtx().connectionString })
    try {
      const postings = await pool.query<{ count: number }>(`select count(*)::int as count from postings where idempotency_key = $1`, [
        key,
      ])
      expect(postings.rows[0]?.count).toBe(1)
    } finally {
      await pool.end()
    }
  })

  it('replaying the same key with a different body is idempotency_mismatch, never a second posting', async () => {
    const user = await registerCustomer(getCtx(), 'topup-idem-mismatch@example.test')
    const key = idempotencyKey()

    const first = await topup(user.cookie, 60_000, key)
    expect(first.status).toBe(201)

    const second = await topup(user.cookie, 90_000, key)
    expect(second.status).toBe(422)
    expect(ApiErrorSchema.parse(second.body).code).toBe('idempotency_mismatch')

    const balance = await getCtx().request.get(API.wallet.me).set('Cookie', user.cookie)
    expect(WalletSchema.parse(balance.body).balanceKobo).toBe(60_000)
  })

  it('a client cannot forge a ledger posting through extra request fields — they are silently ignored', async () => {
    const user = await registerCustomer(getCtx(), 'topup-forged-fields@example.test')

    const response = await getCtx()
      .request.post(API.wallet.topup)
      .set('Cookie', user.cookie)
      .set('Idempotency-Key', idempotencyKey())
      .send({
        amountKobo: 40_000,
        accountId: 'evil_account',
        postingId: 'forged_posting',
        moneyMoved: true,
        entries: [{ accountId: 'evil_account', amountKobo: 999_999_999 }],
      })

    expect(response.status).toBe(201)
    const body = TransferResponseSchema.parse(response.body)
    expect(body.transaction.amountKobo).toBe(40_000)
    expect(body.wallet.balanceKobo).toBe(40_000)
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
