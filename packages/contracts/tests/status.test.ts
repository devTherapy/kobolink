import { describe, expect, it } from 'vitest'
import { displayStatus, exampleLink, resolveLink, toPublicLinkState, type PaymentLink } from '../src/index.js'

const NOW = new Date('2026-06-15T12:00:00Z')
const link = (overrides: Partial<PaymentLink> = {}) => exampleLink({ paymentCount: 0, totalPaidKobo: 0, ...overrides })

describe('resolveLink', () => {
  it('is not-found for a missing link', () => {
    expect(resolveLink(null, NOW)).toEqual({ kind: 'not-found' })
  })

  it('is payable in the ordinary case', () => {
    expect(resolveLink(link(), NOW).kind).toBe('payable')
  })

  it('prefers disabled over expiry — the merchant switched it off deliberately', () => {
    const l = link({ status: 'disabled', expiresAt: '2026-01-01T00:00:00Z' })
    expect(resolveLink(l, NOW).kind).toBe('disabled')
  })

  it('expires exactly at the boundary, not a moment later', () => {
    const at = NOW.toISOString()
    expect(resolveLink(link({ expiresAt: at }), NOW).kind).toBe('expired')
    const later = new Date(NOW.getTime() + 1000).toISOString()
    expect(resolveLink(link({ expiresAt: later }), NOW).kind).toBe('payable')
  })

  it('ignores an unparseable expiry rather than locking the link', () => {
    expect(resolveLink(link({ expiresAt: 'not-a-date' }), NOW).kind).toBe('payable')
  })

  it('closes a single-use link once it has been paid', () => {
    expect(resolveLink(link({ isReusable: false, paymentCount: 1 }), NOW).kind).toBe('already-paid')
    expect(resolveLink(link({ isReusable: true, paymentCount: 9 }), NOW).kind).toBe('payable')
  })

  it('works on the public projection too, so the checkout page and the API agree', () => {
    const publicish = { status: 'active' as const, isReusable: false, expiresAt: null, paymentCount: 1 }
    expect(resolveLink(publicish, NOW).kind).toBe('already-paid')
  })
})

describe('toPublicLinkState', () => {
  it('maps every resolution to the wire state, and not-found to null (a 404, never a body)', () => {
    expect(toPublicLinkState(resolveLink(null, NOW))).toBeNull()
    expect(toPublicLinkState(resolveLink(link(), NOW))).toBe('payable')
    expect(toPublicLinkState(resolveLink(link({ status: 'disabled' }), NOW))).toBe('disabled')
    expect(toPublicLinkState(resolveLink(link({ expiresAt: '2026-01-01T00:00:00Z' }), NOW))).toBe('expired')
    expect(toPublicLinkState(resolveLink(link({ isReusable: false, paymentCount: 1 }), NOW))).toBe('already-paid')
  })
})

describe('displayStatus', () => {
  it.each([
    [link(), 'Active'],
    [link({ status: 'disabled' }), 'Disabled'],
    [link({ expiresAt: '2026-01-01T00:00:00Z' }), 'Expired'],
    [link({ isReusable: false, paymentCount: 1 }), 'Paid'],
  ] as const)('renders the badge the merchant expects', (l, expected) => {
    expect(displayStatus(l, NOW)).toBe(expected)
  })
})
