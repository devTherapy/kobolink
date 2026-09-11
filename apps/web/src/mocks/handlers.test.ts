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

function idemKey(suffix: string): string {
  return `test-idem-key-${suffix}`
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

describe('checkout.initialize', () => {
  it('rejects an amount that does not match a fixed-amount link with amount_mismatch (finding 1)', async () => {
    // The seeded default link (state.ts) has a fixed amountKobo of 1_850_000.
    const { status, json } = await postJson(
      '/api/checkout/initialize',
      { code: 'aBcDeFgH', amountKobo: 999_00, payerName: 'Ngozi Okafor', payerEmail: 'ngozi@example.com' },
      { [IDEMPOTENCY_HEADER]: idemKey('mismatch') },
    )
    expect(status).toBe(422)
    expect(json).toMatchObject({ code: 'amount_mismatch', moneyMoved: false })
  })

  it('accepts an amount that matches the fixed amount', async () => {
    const { status, json } = await postJson(
      '/api/checkout/initialize',
      { code: 'aBcDeFgH', amountKobo: 1_850_000, payerName: 'Ngozi Okafor', payerEmail: 'ngozi@example.com' },
      { [IDEMPOTENCY_HEADER]: idemKey('match') },
    )
    expect(status).toBe(201)
    expect(json).toMatchObject({ code: 'aBcDeFgH', amountKobo: 1_850_000, status: 'pending' })
  })
})

describe('checkout.verify (finding 3: simulated decline)', () => {
  async function initialize(payerEmail: string, key: string) {
    const { json } = await postJson(
      '/api/checkout/initialize',
      { code: 'aBcDeFgH', amountKobo: 1_850_000, payerName: 'Ngozi Okafor', payerEmail },
      { [IDEMPOTENCY_HEADER]: idemKey(key) },
    )
    return (json as { reference: string }).reference
  }

  it('declines when the payer email starts with fail@, and money did not move', async () => {
    const reference = await initialize('fail@example.com', 'decline-init')
    const { status, json } = await postJson(
      '/api/checkout/verify',
      { reference },
      { [IDEMPOTENCY_HEADER]: idemKey('decline-verify') },
    )
    expect(status).toBe(200)
    expect(json).toMatchObject({
      payment: { status: 'failed', moneyMoved: false },
    })
    expect((json as { payment: { failureReason: string | null } }).payment.failureReason).toBeTruthy()
  })

  it('succeeds for any other payer email, and money moved', async () => {
    const reference = await initialize('ngozi@example.com', 'success-init')
    const { status, json } = await postJson(
      '/api/checkout/verify',
      { reference },
      { [IDEMPOTENCY_HEADER]: idemKey('success-verify') },
    )
    expect(status).toBe(200)
    expect(json).toMatchObject({
      payment: { status: 'success', moneyMoved: true, failureReason: null },
    })
  })
})

describe('idempotency replay (finding 4)', () => {
  it('replaying the same key with the same body returns the original response, not a new posting', async () => {
    const key = idemKey('replay-same')
    const body = { code: 'aBcDeFgH', amountKobo: 1_850_000, payerName: 'Ngozi Okafor', payerEmail: 'ngozi@example.com' }

    const first = await postJson('/api/checkout/initialize', body, { [IDEMPOTENCY_HEADER]: key })
    const second = await postJson('/api/checkout/initialize', body, { [IDEMPOTENCY_HEADER]: key })

    expect(second.status).toBe(first.status)
    expect(second.json).toEqual(first.json)
  })

  it('the same key with a different body is idempotency_mismatch', async () => {
    const key = idemKey('replay-diff')
    const bodyA = { code: 'aBcDeFgH', amountKobo: 1_850_000, payerName: 'Ngozi Okafor', payerEmail: 'ngozi@example.com' }
    const bodyB = { ...bodyA, payerEmail: 'someone-else@example.com' }

    await postJson('/api/checkout/initialize', bodyA, { [IDEMPOTENCY_HEADER]: key })
    const { status, json } = await postJson('/api/checkout/initialize', bodyB, { [IDEMPOTENCY_HEADER]: key })

    expect(status).toBe(422)
    expect(json).toMatchObject({ code: 'idempotency_mismatch', moneyMoved: false })
  })
})

describe('malformed or unknown link codes (finding 5)', () => {
  it('GET /api/links/:code/public 404s for a malformed code instead of crashing', async () => {
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

describe('public resolve computes state with resolveLink() (finding 6)', () => {
  it('reflects a status flipped to disabled by PATCH .../status', async () => {
    await patchJson('/api/links/aBcDeFgH/status', { status: 'disabled' })
    const { json } = await getJson('/api/links/aBcDeFgH/public')
    expect(json).toMatchObject({ state: 'disabled' })
  })

  it('resolves an expired link to state expired', async () => {
    const code = newLinkCode()
    linkStore.set(code, exampleLink({ code, expiresAt: '2020-01-01T00:00:00.000Z' }))
    const { json } = await getJson(`/api/links/${code}/public`)
    expect(json).toMatchObject({ state: 'expired' })
  })

  it('resolves an exhausted single-use link to state already-paid', async () => {
    const code = newLinkCode()
    linkStore.set(code, exampleLink({ code, isReusable: false, paymentCount: 1 }))
    const { json } = await getJson(`/api/links/${code}/public`)
    expect(json).toMatchObject({ state: 'already-paid' })
  })

  it('resolves an active, unexpired, reusable link to state payable', async () => {
    const code = newLinkCode()
    linkStore.set(code, exampleLink({ code, status: 'active', isReusable: true, expiresAt: null }))
    const { json } = await getJson(`/api/links/${code}/public`)
    expect(json).toMatchObject({ state: 'payable' })
  })
})

describe('wallet.transfer overdraft protection (finding 7)', () => {
  it('rejects a transfer larger than the balance with insufficient_funds, and the balance does not move', async () => {
    const { status, json } = await postJson(
      '/api/wallet/transfer',
      { toPhone: '+2348031234567', amountKobo: INITIAL_WALLET_BALANCE_KOBO + 1 },
      { [IDEMPOTENCY_HEADER]: idemKey('overdraft') },
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
      { [IDEMPOTENCY_HEADER]: idemKey('within-balance') },
    )
    expect(status).toBe(200)

    const { json: wallet } = await getJson('/api/wallet')
    expect(wallet).toMatchObject({ balanceKobo: INITIAL_WALLET_BALANCE_KOBO - 2_000_000 })
  })
})
