import { randomUUID } from 'node:crypto'
import { API, ApiErrorSchema, WalletSchema, WalletTransactionListResponseSchema } from '@kobolink/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerCustomer, registerMerchant } from './support/register-user.js'

/** `GET /api/wallet` and `GET /api/wallet/transactions` — PLAN.md's B8 row: balance is always derived, never stored. */
describe('GET /api/wallet, GET /api/wallet/transactions (real Postgres via Testcontainers)', () => {
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

  function transfer(cookie: string, toPhone: string, amountKobo: number, note?: string) {
    return getCtx()
      .request.post(API.wallet.transfer)
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey())
      .send({ toPhone, amountKobo, ...(note !== undefined ? { note } : {}) })
  }

  describe('GET /api/wallet', () => {
    it('401s with no session', async () => {
      const response = await getCtx().request.get(API.wallet.me)
      expect(response.status).toBe(401)
      expect(ApiErrorSchema.parse(response.body).code).toBe('unauthenticated')
    })

    it('a brand-new user has a zero balance and a real accountId, with no ledger activity at all', async () => {
      const user = await registerCustomer(getCtx(), 'wallet-read-new@example.test')
      const response = await getCtx().request.get(API.wallet.me).set('Cookie', user.cookie)

      expect(response.status).toBe(200)
      const wallet = WalletSchema.parse(response.body)
      expect(wallet.balanceKobo).toBe(0)
      expect(wallet.accountId.length).toBeGreaterThan(0)
      expect(wallet.currency).toBe('NGN')
    })

    it('balance is exactly the sum of this account’s own ledger entries after a mix of topups and transfers', async () => {
      const sender = await registerCustomer(getCtx(), 'wallet-read-mix-sender@example.test', 'A Customer', '+2348030002001')
      const recipient = await registerMerchant(getCtx(), 'wallet-read-mix-recipient@example.test', 'A Merchant', '+2348030002002')

      await topup(sender.cookie, 200_000)
      await topup(sender.cookie, 50_000)
      const sent = await transfer(sender.cookie, recipient.phone ?? '', 70_000)
      expect(sent.status).toBe(201)

      const senderWallet = await getCtx().request.get(API.wallet.me).set('Cookie', sender.cookie)
      expect(WalletSchema.parse(senderWallet.body).balanceKobo).toBe(180_000)

      const recipientWallet = await getCtx().request.get(API.wallet.me).set('Cookie', recipient.cookie)
      expect(WalletSchema.parse(recipientWallet.body).balanceKobo).toBe(70_000)
    })
  })

  describe('GET /api/wallet/transactions', () => {
    it('401s with no session', async () => {
      const response = await getCtx().request.get(API.wallet.transactions)
      expect(response.status).toBe(401)
      expect(ApiErrorSchema.parse(response.body).code).toBe('unauthenticated')
    })

    it('a brand-new user (no wallet account provisioned yet) sees an empty page, not an error', async () => {
      const user = await registerCustomer(getCtx(), 'wallet-tx-new@example.test')
      const response = await getCtx().request.get(API.wallet.transactions).set('Cookie', user.cookie)

      expect(response.status).toBe(200)
      const page = WalletTransactionListResponseSchema.parse(response.body)
      expect(page.items).toEqual([])
      expect(page.nextCursor).toBeNull()
    })

    it('lists topups and transfers newest first, each signed from this account’s own point of view', async () => {
      const sender = await registerCustomer(getCtx(), 'wallet-tx-list-sender@example.test', 'A Customer', '+2348030003001')
      const recipient = await registerMerchant(getCtx(), 'wallet-tx-list-recipient@example.test', 'A Merchant', '+2348030003002')

      await topup(sender.cookie, 300_000)
      const sent = await transfer(sender.cookie, recipient.phone ?? '', 40_000, 'for the books')
      expect(sent.status).toBe(201)

      const senderPage = await getCtx().request.get(API.wallet.transactions).set('Cookie', sender.cookie)
      const senderItems = WalletTransactionListResponseSchema.parse(senderPage.body).items
      expect(senderItems).toHaveLength(2)
      expect(senderItems[0]?.kind).toBe('transfer')
      expect(senderItems[0]?.amountKobo).toBe(-40_000)
      expect(senderItems[0]?.counterparty).toBe(recipient.displayName)
      expect(senderItems[0]?.note).toBe('for the books')
      expect(senderItems[1]?.kind).toBe('topup')
      expect(senderItems[1]?.amountKobo).toBe(300_000)
      expect(senderItems[1]?.counterparty).toBeNull()

      const recipientPage = await getCtx().request.get(API.wallet.transactions).set('Cookie', recipient.cookie)
      const recipientItems = WalletTransactionListResponseSchema.parse(recipientPage.body).items
      expect(recipientItems).toHaveLength(1)
      expect(recipientItems[0]?.kind).toBe('transfer')
      expect(recipientItems[0]?.amountKobo).toBe(40_000)
      expect(recipientItems[0]?.counterparty).toBe(sender.displayName)
    })

    it('pages with limit and nextCursor, and the second page picks up exactly where the first left off', async () => {
      const user = await registerCustomer(getCtx(), 'wallet-tx-paging@example.test')
      for (let i = 0; i < 5; i += 1) {
        const response = await topup(user.cookie, 10_000 + i)
        expect(response.status).toBe(201)
      }

      const firstPage = await getCtx().request.get(`${API.wallet.transactions}?limit=2`).set('Cookie', user.cookie)
      const first = WalletTransactionListResponseSchema.parse(firstPage.body)
      expect(first.items).toHaveLength(2)
      expect(first.nextCursor).not.toBeNull()

      const secondPage = await getCtx()
        .request.get(`${API.wallet.transactions}?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`)
        .set('Cookie', user.cookie)
      const second = WalletTransactionListResponseSchema.parse(secondPage.body)
      expect(second.items).toHaveLength(2)

      const firstIds = first.items.map((item) => item.postingId)
      const secondIds = second.items.map((item) => item.postingId)
      expect(new Set([...firstIds, ...secondIds]).size).toBe(4)
    })

    it('400s on a malformed cursor', async () => {
      const user = await registerCustomer(getCtx(), 'wallet-tx-bad-cursor@example.test')
      const response = await getCtx().request.get(`${API.wallet.transactions}?cursor=not-a-real-cursor`).set('Cookie', user.cookie)
      expect(response.status).toBe(400)
      expect(ApiErrorSchema.parse(response.body).code).toBe('validation_failed')
    })
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
