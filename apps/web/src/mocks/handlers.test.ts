import { describe, expect, it } from 'vitest'
import { IDEMPOTENCY_HEADER, exampleLink, newLinkCode } from '@kobolink/contracts'
import { INITIAL_WALLET_BALANCE_KOBO, linkStore } from './state'

/**
 * The MSW handler set is the backend every other F0+ test, and every screen
 * built against it before `apps/api` exists, trusts. These tests hold it to
 * the contract README's endpoint table directly — no React component in the
 * way — so a handler that drifts from the README fails here, not three
 * features later when a screen built against it turns out to be wrong.
 */

const ORIGIN = 'http://localhost:3000'
const DEFAULT_CODE = 'aBcDeFgH' // The seeded default link — state.ts.
const DEFAULT_AMOUNT_KOBO = 1_850_000 // Its fixed amount — state.ts.

let idemCounter = 0
/** IdempotencyKeySchema requires at least 16 characters — pad the counter so every key clears it. */
function idemKey(): string {
  idemCounter += 1
  return `test-idem-key-${String(idemCounter).padStart(4, '0')}`
}

async function postJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const json: unknown = await response.json()
  return { status: response.status, json }
}

async function getJson(path: string): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${ORIGIN}${path}`)
  const json: unknown = await response.json()
  return { status: response.status, json }
}

async function patchJson(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${ORIGIN}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json: unknown = await response.json()
  return { status: response.status, json }
}

/** Initializes a checkout and returns its reference. */
async function initializeCheckout(
  code: string,
  amountKobo: number,
  payerEmail: string,
): Promise<string> {
  const { json } = await postJson(
    '/api/checkout/initialize',
    { code, amountKobo, payerName: 'Ngozi Okafor', payerEmail },
    { [IDEMPOTENCY_HEADER]: idemKey() },
  )
  return (json as { reference: string }).reference
}

/** Initializes and verifies a checkout with a payer email that does not decline. */
async function payLink(code: string, amountKobo: number): Promise<void> {
  const reference = await initializeCheckout(code, amountKobo, 'ngozi@example.com')
  await postJson('/api/checkout/verify', { reference }, { [IDEMPOTENCY_HEADER]: idemKey() })
}

describe('checkout.initialize: amount_mismatch on a fixed-amount link', () => {
  it('rejects an amount that does not match the link', async () => {
    const { status, json } = await postJson(
      '/api/checkout/initialize',
      { code: DEFAULT_CODE, amountKobo: 999_00, payerName: 'Ngozi Okafor', payerEmail: 'ngozi@example.com' },
      { [IDEMPOTENCY_HEADER]: idemKey() },
    )
    expect(status).toBe(422)
    expect(json).toMatchObject({ code: 'amount_mismatch', moneyMoved: false })
  })

  it('accepts an amount that matches the fixed amount', async () => {
    const { status, json } = await postJson(
      '/api/checkout/initialize',
      { code: DEFAULT_CODE, amountKobo: DEFAULT_AMOUNT_KOBO, payerName: 'Ngozi Okafor', payerEmail: 'ngozi@example.com' },
      { [IDEMPOTENCY_HEADER]: idemKey() },
    )
    expect(status).toBe(201)
    expect(json).toMatchObject({ code: DEFAULT_CODE, amountKobo: DEFAULT_AMOUNT_KOBO, status: 'pending' })
  })
})

describe('checkout.verify: the simulated gateway', () => {
  it('declines when the payer email starts with fail@, and money did not move', async () => {
    const reference = await initializeCheckout(DEFAULT_CODE, DEFAULT_AMOUNT_KOBO, 'fail@example.com')
    const { status, json } = await postJson('/api/checkout/verify', { reference }, { [IDEMPOTENCY_HEADER]: idemKey() })
    expect(status).toBe(200)
    expect(json).toMatchObject({ payment: { status: 'failed', moneyMoved: false } })
    expect((json as { payment: { failureReason: string | null } }).payment.failureReason).toBeTruthy()
  })

  it('succeeds for any other payer email, and money moved', async () => {
    const reference = await initializeCheckout(DEFAULT_CODE, DEFAULT_AMOUNT_KOBO, 'ngozi@example.com')
    const { status, json } = await postJson('/api/checkout/verify', { reference }, { [IDEMPOTENCY_HEADER]: idemKey() })
    expect(status).toBe(200)
    expect(json).toMatchObject({ payment: { status: 'success', moneyMoved: true, failureReason: null } })
  })

  it('is a read of one outcome: verifying the same reference again (a different Idempotency-Key) returns the original payment, and does not post twice', async () => {
    const reference = await initializeCheckout(DEFAULT_CODE, DEFAULT_AMOUNT_KOBO, 'ngozi@example.com')
    const first = await postJson('/api/checkout/verify', { reference }, { [IDEMPOTENCY_HEADER]: idemKey() })
    const second = await postJson('/api/checkout/verify', { reference }, { [IDEMPOTENCY_HEADER]: idemKey() })

    expect(second.json).toEqual(first.json)

    const { json: link } = await getJson(`/api/links/${DEFAULT_CODE}`)
    // Seeded at paymentCount 3 (state.ts) — exactly one payment posted, not two.
    expect(link).toMatchObject({ paymentCount: 4, totalPaidKobo: 5_550_000 + DEFAULT_AMOUNT_KOBO })
  })
})

describe('Idempotency-Key: "a replay ... returns the stored response ... the same key with a different body is idempotency_mismatch"', () => {
  it('replaying the same key with the same body returns the original response, not a new posting', async () => {
    const key = idemKey()
    const body = { code: DEFAULT_CODE, amountKobo: DEFAULT_AMOUNT_KOBO, payerName: 'Ngozi Okafor', payerEmail: 'ngozi@example.com' }

    const first = await postJson('/api/checkout/initialize', body, { [IDEMPOTENCY_HEADER]: key })
    const second = await postJson('/api/checkout/initialize', body, { [IDEMPOTENCY_HEADER]: key })

    expect(second.status).toBe(first.status)
    expect(second.json).toEqual(first.json)
  })

  it('the same key with a different body is idempotency_mismatch', async () => {
    const key = idemKey()
    const bodyA = { code: DEFAULT_CODE, amountKobo: DEFAULT_AMOUNT_KOBO, payerName: 'Ngozi Okafor', payerEmail: 'ngozi@example.com' }
    const bodyB = { ...bodyA, payerEmail: 'someone-else@example.com' }

    await postJson('/api/checkout/initialize', bodyA, { [IDEMPOTENCY_HEADER]: key })
    const { status, json } = await postJson('/api/checkout/initialize', bodyB, { [IDEMPOTENCY_HEADER]: key })

    expect(status).toBe(422)
    expect(json).toMatchObject({ code: 'idempotency_mismatch', moneyMoved: false })
  })
})

describe('a malformed or unknown link code is not_found, never a crash', () => {
  it('GET /api/links/:code/public 404s for a malformed code', async () => {
    const { status, json } = await getJson('/api/links/too-short/public')
    expect(status).toBe(404)
    expect(json).toMatchObject({ code: 'not_found' })
  })

  it('GET /api/links/:code/public 404s for a well-formed but unknown code', async () => {
    const { status, json } = await getJson('/api/links/zzzzzzzz/public')
    expect(status).toBe(404)
    expect(json).toMatchObject({ code: 'not_found' })
  })

  it('GET /api/links/:code (merchant view) 404s the same way', async () => {
    const { status } = await getJson('/api/links/zzzzzzzz')
    expect(status).toBe(404)
  })

  it('GET /api/links/:code/payments 404s the same way', async () => {
    const { status } = await getJson('/api/links/zzzzzzzz/payments')
    expect(status).toBe(404)
  })

  it('PATCH /api/links/:code/status 404s the same way', async () => {
    const { status } = await patchJson('/api/links/zzzzzzzz/status', { status: 'disabled' })
    expect(status).toBe(404)
  })
})

describe('public resolve computes state with resolveLink(), not a hardcoded "payable"', () => {
  it('reflects a status flipped to disabled by PATCH .../status', async () => {
    await patchJson(`/api/links/${DEFAULT_CODE}/status`, { status: 'disabled' })
    const { json } = await getJson(`/api/links/${DEFAULT_CODE}/public`)
    expect(json).toMatchObject({ state: 'disabled' })
  })

  it('resolves an expired link to state expired', async () => {
    const code = newLinkCode()
    linkStore.set(code, exampleLink({ code, expiresAt: '2020-01-01T00:00:00.000Z' }))
    const { json } = await getJson(`/api/links/${code}/public`)
    expect(json).toMatchObject({ state: 'expired' })
  })

  it('resolves an active, unexpired, reusable link to state payable', async () => {
    const code = newLinkCode()
    linkStore.set(code, exampleLink({ code, status: 'active', isReusable: true, expiresAt: null }))
    const { json } = await getJson(`/api/links/${code}/public`)
    expect(json).toMatchObject({ state: 'payable' })
  })

  it('a single-use link becomes already-paid once it is actually paid — driven through initialize -> verify -> resolve, not a seeded paymentCount', async () => {
    const code = newLinkCode()
    const amountKobo = 500_00
    linkStore.set(code, exampleLink({ code, isReusable: false, paymentCount: 0, totalPaidKobo: 0, amountKobo }))

    // Before payment: payable.
    expect((await getJson(`/api/links/${code}/public`)).json).toMatchObject({ state: 'payable' })

    await payLink(code, amountKobo)

    // After payment: already-paid.
    expect((await getJson(`/api/links/${code}/public`)).json).toMatchObject({ state: 'already-paid' })

    // The real API's answer to a second attempt: link_not_payable, not a second charge.
    const second = await postJson(
      '/api/checkout/initialize',
      { code, amountKobo, payerName: 'Ngozi Okafor', payerEmail: 'ngozi@example.com' },
      { [IDEMPOTENCY_HEADER]: idemKey() },
    )
    expect(second.status).toBe(409)
    expect(second.json).toMatchObject({ code: 'link_not_payable', state: 'already-paid', moneyMoved: false })
  })
})

describe('the numbers agree with the lists beneath them', () => {
  it('after create -> initialize -> verify, dashboard stats, the link counters, and the payments list all agree', async () => {
    const { json: created } = await postJson('/api/links', { title: 'Handmade Beads', amountKobo: 750_00, isReusable: true })
    const code = (created as { code: string }).code

    await payLink(code, 750_00)

    const { json: link } = await getJson(`/api/links/${code}`)
    expect(link).toMatchObject({ paymentCount: 1, totalPaidKobo: 750_00 })

    const { json: payments } = await getJson(`/api/links/${code}/payments`)
    expect((payments as { items: unknown[] }).items).toHaveLength(1)

    const { json: stats } = await getJson('/api/dashboard/stats')
    // The seeded default link contributes 3 payments / 5_550_000 (state.ts);
    // this test's link, reusable, is still payable and adds a fourth.
    expect(stats).toMatchObject({
      paymentCount: 4,
      totalCollectedKobo: 5_550_000 + 750_00,
      activeLinks: 2,
    })
  })
})

describe('GET /api/links: newest first', () => {
  it('lists a newly created link before the seeded default', async () => {
    await postJson('/api/links', { title: 'A Second Link' })
    const { json } = await getJson('/api/links')
    const items = (json as { items: { title: string }[] }).items
    expect(items[0]?.title).toBe('A Second Link')
  })
})

describe('wallet.transfer: overdraft is rejected, not posted', () => {
  it('rejects a transfer larger than the balance with insufficient_funds, and the balance does not move', async () => {
    const { status, json } = await postJson(
      '/api/wallet/transfer',
      { toPhone: '+2348031234567', amountKobo: INITIAL_WALLET_BALANCE_KOBO + 1 },
      { [IDEMPOTENCY_HEADER]: idemKey() },
    )
    expect(status).toBe(422)
    expect(json).toMatchObject({ code: 'insufficient_funds', moneyMoved: false })

    const { json: wallet } = await getJson('/api/wallet')
    expect(wallet).toMatchObject({ balanceKobo: INITIAL_WALLET_BALANCE_KOBO })
  })

  it('accepts a transfer within the balance and debits it', async () => {
    const { status } = await postJson(
      '/api/wallet/transfer',
      { toPhone: '+2348031234567', amountKobo: 2_000_000 },
      { [IDEMPOTENCY_HEADER]: idemKey() },
    )
    expect(status).toBe(200)

    const { json: wallet } = await getJson('/api/wallet')
    expect(wallet).toMatchObject({ balanceKobo: INITIAL_WALLET_BALANCE_KOBO - 2_000_000 })
  })
})

describe('a malformed JSON body is validation_failed, not a crash', () => {
  it('POST /api/links with unparseable JSON answers 400, not a generic 500', async () => {
    const response = await fetch(`${ORIGIN}/api/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not valid json',
    })
    const json: unknown = await response.json()
    expect(response.status).toBe(400)
    expect(json).toMatchObject({ code: 'validation_failed' })
  })
})
