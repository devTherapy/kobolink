import { PaymentLinkSchema } from '@kobolink/contracts'
import { describe, expect, it } from 'vitest'
import type * as schema from '../db/schema/index.js'
import { toPaymentLink } from './link-mapper.js'

type LinkRow = typeof schema.links.$inferSelect

function makeRow(overrides: Partial<LinkRow> = {}): LinkRow {
  return {
    code: 'KBLDEMX2',
    merchantUserId: 'u_merchant123',
    title: 'Consulting session',
    description: 'One hour, paid up front.',
    amountKobo: 500_000,
    status: 'active',
    isReusable: true,
    expiresAt: null,
    createdAt: new Date('2026-09-01T12:00:00.000Z'),
    ...overrides,
  }
}

describe('toPaymentLink', () => {
  it('maps a row to a PaymentLink that satisfies the contract schema exactly', () => {
    const link = toPaymentLink(makeRow(), 'Adebayo Stores', 3, 1_500_000)

    expect(() => PaymentLinkSchema.parse(link)).not.toThrow()
    expect(link).toEqual({
      code: 'KBLDEMX2',
      merchantId: 'u_merchant123',
      merchantName: 'Adebayo Stores',
      title: 'Consulting session',
      description: 'One hour, paid up front.',
      amountKobo: 500_000,
      currency: 'NGN',
      status: 'active',
      isReusable: true,
      expiresAt: null,
      createdAt: '2026-09-01T12:00:00.000Z',
      paymentCount: 3,
      totalPaidKobo: 1_500_000,
    })
  })

  it('maps a null description, null amountKobo (payer names the amount) and a null expiresAt straight through as null', () => {
    const link = toPaymentLink(makeRow({ description: null, amountKobo: null, expiresAt: null }), 'Adebayo Stores', 0, 0)

    expect(link.description).toBeNull()
    expect(link.amountKobo).toBeNull()
    expect(link.expiresAt).toBeNull()
  })

  it('formats a non-null expiresAt as an RFC 3339 IsoDateTime, not the raw Date', () => {
    const link = toPaymentLink(
      makeRow({ expiresAt: new Date('2026-12-31T23:59:59.000Z') }),
      'Adebayo Stores',
      0,
      0,
    )

    expect(link.expiresAt).toBe('2026-12-31T23:59:59.000Z')
  })

  it('maps the disabled status through unchanged', () => {
    const link = toPaymentLink(makeRow({ status: 'disabled' }), 'Adebayo Stores', 0, 0)
    expect(link.status).toBe('disabled')
  })

  it('throws — rather than silently returning a contract-violating body — if a row value fails PaymentLinkSchema', () => {
    // A row's `code` column is a plain varchar(8); nothing at the type level
    // stops it holding something that isn't 8 mistranscription-safe-alphabet
    // characters. `toPaymentLink` must not forward that silently.
    const row = makeRow({ code: 'too-short' })
    expect(() => toPaymentLink(row, 'Adebayo Stores', 0, 0)).toThrow()
  })
})
