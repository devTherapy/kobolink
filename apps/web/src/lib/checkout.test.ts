import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { API, exampleLink, toPublicLink } from '@kobolink/contracts'
import { server } from '@/mocks/server'
import {
  checkoutTitle,
  formatCheckoutDate,
  resolveCheckoutLink,
  CheckoutUnavailableError,
  NON_PAYABLE_COPY,
} from './checkout'

describe('resolveCheckoutLink', () => {
  it('resolves the seeded fixture link', async () => {
    const resolution = await resolveCheckoutLink('aBcDeFgH')
    expect(resolution).toMatchObject({ found: true, data: { state: 'payable' } })
  })

  it('answers not-found for a malformed code without spending a request', async () => {
    server.use(
      http.get(API.links.resolve(':code'), () => {
        throw new Error('should not be called for a malformed code')
      }),
    )
    const resolution = await resolveCheckoutLink('not-a-code')
    expect(resolution).toEqual({ found: false })
  })

  it('answers not-found for a well-formed but unknown code', async () => {
    const resolution = await resolveCheckoutLink('zZzZzZzZ')
    expect(resolution).toEqual({ found: false })
  })

  it('maps a non-not_found ApiError (5xx, rate_limited, ...) to CheckoutUnavailableError', async () => {
    server.use(
      http.get(API.links.resolve(':code'), () =>
        HttpResponse.json({ code: 'internal', message: 'boom' }, { status: 500 }),
      ),
    )
    await expect(resolveCheckoutLink('aBcDeFgH')).rejects.toThrow(CheckoutUnavailableError)
  })

  it('maps a raw transport failure (no ApiError body at all) to CheckoutUnavailableError too', async () => {
    server.use(http.get(API.links.resolve(':code'), () => HttpResponse.error()))
    await expect(resolveCheckoutLink('aBcDeFgH')).rejects.toThrow(CheckoutUnavailableError)
  })
})

describe('checkoutTitle', () => {
  const link = toPublicLink(exampleLink())

  it('matches the Done-when fixture title exactly', () => {
    expect(checkoutTitle('payable', link)).toBe('Pay ₦18,500 to Adebayo Stores')
  })

  it('drops the amount for an open-amount link', () => {
    expect(checkoutTitle('payable', { ...link, amountKobo: null })).toBe('Pay Adebayo Stores')
  })

  it('names the merchant honestly for every non-payable state', () => {
    expect(checkoutTitle('disabled', link)).toBe('This link is turned off — Adebayo Stores')
    expect(checkoutTitle('expired', link)).toBe('This link has expired — Adebayo Stores')
    expect(checkoutTitle('already-paid', link)).toBe('This link has already been paid — Adebayo Stores')
  })
})

describe('formatCheckoutDate', () => {
  it('renders a human-readable date, not a raw ISO string', () => {
    const formatted = formatCheckoutDate('2026-06-15T12:00:00.000Z')
    // Not `not.toContain('T')` — the zone abbreviation this now includes
    // (WAT) legitimately contains a "T". What must not survive is the ISO
    // `<date>T<time>` separator itself.
    expect(formatted).not.toMatch(/\dT\d/)
    expect(formatted).toMatch(/2026/)
  })

  it('is pinned to Africa/Lagos and names the zone, so SSR and client agree', () => {
    // Noon UTC is 13:00 in Lagos (WAT, UTC+1, no DST) — if this were
    // rendered in the runtime's local zone instead, a non-WAT machine
    // (exactly what CI and a payer's own device can be) would show a
    // different hour.
    const formatted = formatCheckoutDate('2026-06-15T12:00:00.000Z')
    expect(formatted).toContain('13:00')
    expect(formatted).toMatch(/WAT|GMT\+1/)
  })
})

describe('NON_PAYABLE_COPY', () => {
  const link = toPublicLink(exampleLink())

  it('names what happened for every state', () => {
    expect(NON_PAYABLE_COPY.disabled.body(link)).toContain('Adebayo Stores')
    expect(NON_PAYABLE_COPY.expired.body(link)).toMatch(/expired/i)
    expect(NON_PAYABLE_COPY['already-paid'].body(link)).toMatch(/already been used/i)
  })

  it('offers a next step naming the merchant for every state', () => {
    for (const state of ['disabled', 'expired', 'already-paid'] as const) {
      expect(NON_PAYABLE_COPY[state].nextStep(link)).toContain('Adebayo Stores')
    }
  })
})
