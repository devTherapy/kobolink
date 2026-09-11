import { describe, expect, it } from 'vitest'
import { displayStatus, resolveLink } from '@/lib/status'
import type { PaymentLink } from '@/types'

const NOW = new Date('2026-06-15T12:00:00Z')

function link(overrides: Partial<PaymentLink> = {}): PaymentLink {
  return {
    code: 'aBcDeFgH', merchantId: 'm1', merchantName: 'Adebayo Stores',
    title: 'Ankara Two-Piece Set', description: null, amountKobo: 1_850_000,
    currency: 'NGN', status: 'active', isReusable: true, expiresAt: null,
    createdAt: '2026-06-02T09:00:00Z', paymentCount: 0, totalPaidKobo: 0,
    ...overrides,
  }
}

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
