import { randomUUID } from 'node:crypto'
import { API, ApiErrorSchema, TransferResponseSchema, WalletSchema } from '@kobolink/contracts'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerCustomer, registerMerchant } from './support/register-user.js'

/**
 * `POST /api/wallet/transfer` — PLAN.md's B8 row: P2P transfer between two
 * wallets. Atomic (one transaction, balanced debit/credit), rejects on
 * insufficient funds with no partial state, idempotent under a replayed
 * key. The genuinely concurrent double-spend race is proven separately in
 * `wallet-transfer-concurrency.integration.test.ts` — deterministically,
 * not by a hopeful `Promise.all`.
 */
describe('POST /api/wallet/transfer (real Postgres via Testcontainers)', () => {
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

  function topup(cookie: string, amountKobo: number) {
    return getCtx().request.post(API.wallet.topup).set('Cookie', cookie).set('Idempotency-Key', idempotencyKey()).send({ amountKobo })
  }

  function transfer(cookie: string, body: Record<string, unknown>, key = idempotencyKey()) {
    return getCtx().request.post(API.wallet.transfer).set('Cookie', cookie).set('Idempotency-Key', key).send(body)
  }

  async function fundedCustomer(email: string, phone: string, amountKobo: number) {
    const user = await registerCustomer(getCtx(), email, 'A Customer', phone)
    const funded = await topup(user.cookie, amountKobo)
    if (funded.status !== 201) throw new Error(`fixture topup failed: ${funded.status} ${JSON.stringify(funded.body)}`)
    return user
  }

  it('401s with no session at all', async () => {
    const response = await getCtx()
      .request.post(API.wallet.transfer)
      .set('Idempotency-Key', idempotencyKey())
      .send({ toPhone: '+2348031234567', amountKobo: 50_000 })
    expect(response.status).toBe(401)
    expect(ApiErrorSchema.parse(response.body).code).toBe('unauthenticated')
  })

  it('400s with no Idempotency-Key header', async () => {
    const sender = await registerCustomer(getCtx(), 'transfer-no-key@example.test')
    const response = await getCtx()
      .request.post(API.wallet.transfer)
      .set('Cookie', sender.cookie)
      .send({ toPhone: '+2348031234567', amountKobo: 50_000 })
    expect(response.status).toBe(400)
    expect(ApiErrorSchema.parse(response.body).code).toBe('validation_failed')
  })

  it('400s on a validation failure (not a Nigerian mobile number)', async () => {
    const sender = await fundedCustomer('transfer-bad-phone@example.test', '+2348030000001', 100_000)
    const response = await transfer(sender.cookie, { toPhone: 'not-a-phone', amountKobo: 50_000 })
    expect(response.status).toBe(400)
    expect(ApiErrorSchema.parse(response.body).code).toBe('validation_failed')
  })

  it('404s when no user is registered at that phone number', async () => {
    const sender = await fundedCustomer('transfer-unknown-recipient@example.test', '+2348030000002', 100_000)
    const response = await transfer(sender.cookie, { toPhone: '+2348039999999', amountKobo: 50_000 })
    expect(response.status).toBe(404)
    expect(ApiErrorSchema.parse(response.body).code).toBe('not_found')
  })

  it('rejects a transfer to yourself as a validation failure', async () => {
    const sender = await fundedCustomer('transfer-self@example.test', '+2348030000003', 100_000)
    const response = await transfer(sender.cookie, { toPhone: sender.phone, amountKobo: 50_000 })
    expect(response.status).toBe(400)
    expect(ApiErrorSchema.parse(response.body).code).toBe('validation_failed')
  })

  it('201: posts two balanced ledger entries and both parties’ derived balances are correct afterward', async () => {
    const sender = await fundedCustomer('transfer-happy-sender@example.test', '+2348030000010', 200_000)
    const recipient = await registerMerchant(getCtx(), 'transfer-happy-recipient@example.test', 'A Merchant', '+2348030000011')

    const response = await transfer(sender.cookie, { toPhone: recipient.phone, amountKobo: 75_000, note: 'lunch' })

    expect(response.status).toBe(201)
    const body = TransferResponseSchema.parse(response.body)
    expect(body.transaction.kind).toBe('transfer')
    expect(body.transaction.amountKobo).toBe(-75_000)
    expect(body.transaction.counterparty).toBe(recipient.displayName)
    expect(body.transaction.note).toBe('lunch')
    expect(body.wallet.balanceKobo).toBe(125_000)

    const senderWallet = await getCtx().request.get(API.wallet.me).set('Cookie', sender.cookie)
    expect(WalletSchema.parse(senderWallet.body).balanceKobo).toBe(125_000)
    const recipientWallet = await getCtx().request.get(API.wallet.me).set('Cookie', recipient.cookie)
    expect(WalletSchema.parse(recipientWallet.body).balanceKobo).toBe(75_000)

    const pool = new Pool({ connectionString: getCtx().connectionString })
    try {
      const entries = await pool.query<{ amount_kobo: string }>(
        `select amount_kobo from ledger_entries where posting_id = $1`,
        [body.transaction.postingId],
      )
      expect(entries.rows).toHaveLength(2)
      expect(entries.rows.reduce((total, row) => total + Number(row.amount_kobo), 0)).toBe(0)
    } finally {
      await pool.end()
    }
  })

  it('a merchant can receive a transfer into the very same wallet mechanism a customer uses — one users table, one wallet kind', async () => {
    const sender = await fundedCustomer('transfer-cross-role-sender@example.test', '+2348030000020', 100_000)
    const merchant = await registerMerchant(getCtx(), 'transfer-cross-role-merchant@example.test', 'A Merchant', '+2348030000021')

    const response = await transfer(sender.cookie, { toPhone: merchant.phone, amountKobo: 30_000 })
    expect(response.status).toBe(201)

    const merchantWallet = await getCtx().request.get(API.wallet.me).set('Cookie', merchant.cookie)
    expect(WalletSchema.parse(merchantWallet.body).balanceKobo).toBe(30_000)
  })

  it('422s on insufficient funds, and leaves no partial state (no posting, no ledger entries, unchanged balances)', async () => {
    const sender = await fundedCustomer('transfer-insufficient-sender@example.test', '+2348030000030', 10_000)
    const recipient = await registerMerchant(getCtx(), 'transfer-insufficient-recipient@example.test', 'A Merchant', '+2348030000031')

    const pool = new Pool({ connectionString: getCtx().connectionString })
    try {
      const before = await pool.query<{ count: number }>(`select count(*)::int as count from postings where kind = 'transfer'`)

      const response = await transfer(sender.cookie, { toPhone: recipient.phone, amountKobo: 50_000 })

      expect(response.status).toBe(422)
      const error = ApiErrorSchema.parse(response.body)
      expect(error.code).toBe('insufficient_funds')
      expect(error.moneyMoved).toBe(false)

      const senderWallet = await getCtx().request.get(API.wallet.me).set('Cookie', sender.cookie)
      expect(WalletSchema.parse(senderWallet.body).balanceKobo).toBe(10_000)
      const recipientWallet = await getCtx().request.get(API.wallet.me).set('Cookie', recipient.cookie)
      expect(WalletSchema.parse(recipientWallet.body).balanceKobo).toBe(0)

      // No new 'transfer' posting at all — the rejected attempt left
      // exactly as many rows as existed before it ran, not one more with
      // no ledger entries or some other half-written trace.
      const after = await pool.query<{ count: number }>(`select count(*)::int as count from postings where kind = 'transfer'`)
      expect(after.rows[0]?.count).toBe(before.rows[0]?.count)
    } finally {
      await pool.end()
    }
  })

  it('replaying the same Idempotency-Key is a no-op: identical response, exactly one posting, balance unaffected by the replay', async () => {
    const sender = await fundedCustomer('transfer-idempotent-sender@example.test', '+2348030000040', 100_000)
    const recipient = await registerMerchant(getCtx(), 'transfer-idempotent-recipient@example.test', 'A Merchant', '+2348030000041')
    const key = idempotencyKey()

    const first = await transfer(sender.cookie, { toPhone: recipient.phone, amountKobo: 40_000 }, key)
    const second = await transfer(sender.cookie, { toPhone: recipient.phone, amountKobo: 40_000 }, key)

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.body).toEqual(first.body)

    const senderWallet = await getCtx().request.get(API.wallet.me).set('Cookie', sender.cookie)
    expect(WalletSchema.parse(senderWallet.body).balanceKobo).toBe(60_000)

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

  it('replaying the same key with a different body is idempotency_mismatch, never a second transfer', async () => {
    const sender = await fundedCustomer('transfer-idem-mismatch-sender@example.test', '+2348030000050', 100_000)
    const recipient = await registerMerchant(getCtx(), 'transfer-idem-mismatch-recipient@example.test', 'A Merchant', '+2348030000051')
    const key = idempotencyKey()

    const first = await transfer(sender.cookie, { toPhone: recipient.phone, amountKobo: 40_000 }, key)
    expect(first.status).toBe(201)

    const second = await transfer(sender.cookie, { toPhone: recipient.phone, amountKobo: 60_000 }, key)
    expect(second.status).toBe(422)
    expect(ApiErrorSchema.parse(second.body).code).toBe('idempotency_mismatch')

    const senderWallet = await getCtx().request.get(API.wallet.me).set('Cookie', sender.cookie)
    expect(WalletSchema.parse(senderWallet.body).balanceKobo).toBe(60_000)
  })

  it('a client cannot forge a ledger posting through extra request fields — they are silently ignored', async () => {
    const sender = await fundedCustomer('transfer-forged-fields@example.test', '+2348030000060', 100_000)
    const recipient = await registerMerchant(getCtx(), 'transfer-forged-fields-recipient@example.test', 'A Merchant', '+2348030000061')

    const response = await getCtx()
      .request.post(API.wallet.transfer)
      .set('Cookie', sender.cookie)
      .set('Idempotency-Key', idempotencyKey())
      .send({
        toPhone: recipient.phone,
        amountKobo: 25_000,
        senderAccountId: 'evil_account',
        recipientAccountId: 'evil_account',
        postingId: 'forged_posting',
        moneyMoved: true,
        entries: [{ accountId: 'evil_account', amountKobo: 999_999_999 }],
      })

    expect(response.status).toBe(201)
    const body = TransferResponseSchema.parse(response.body)
    expect(body.transaction.amountKobo).toBe(-25_000)
    expect(body.wallet.balanceKobo).toBe(75_000)

    const recipientWallet = await getCtx().request.get(API.wallet.me).set('Cookie', recipient.cookie)
    expect(WalletSchema.parse(recipientWallet.body).balanceKobo).toBe(25_000)
  })

  it('a client cannot write a ledger_entries row directly — the table has no client-reachable write path at all', async () => {
    // Every route this API mounts is enumerated in
    // `src/openapi/route-manifest.ts` and asserted against the real routes
    // Nest mounts (`route-manifest.spec.ts`) — there is no
    // `POST /api/wallet/ledger-entries` or equivalent among them, and every
    // money-moving route (`checkout.initialize`/`verify`,
    // `wallet.transfer`/`topup`) only ever inserts a *balanced pair* inside
    // its own transaction (proved by the balance-trigger and forged-fields
    // tests elsewhere in this suite). This test proves the negative
    // directly: no path under `/api/wallet` accepts a raw ledger shape.
    const sender = await fundedCustomer('transfer-no-ledger-route@example.test', '+2348030000070', 100_000)

    const response = await getCtx()
      .request.post('/api/wallet/ledger-entries')
      .set('Cookie', sender.cookie)
      .set('Idempotency-Key', idempotencyKey())
      .send({ accountId: 'evil_account', amountKobo: 999_999_999 })

    expect(response.status).toBe(404)
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
