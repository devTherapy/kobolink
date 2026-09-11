import { describe, expect, it } from 'vitest'
import {
  CreateLinkRequestSchema,
  PaymentLinkSchema,
  PublicLinkResponseSchema,
  PublicLinkSchema,
  UpdateLinkStatusRequestSchema,
  exampleLink,
  examplePublicLinkResponse,
  toPublicLink,
} from '../src/index.js'

describe('PaymentLinkSchema', () => {
  it('accepts the fixture', () => {
    expect(PaymentLinkSchema.safeParse(exampleLink()).success).toBe(true)
  })

  it('only stores active or disabled — expired and paid are derived, never persisted', () => {
    expect(PaymentLinkSchema.safeParse(exampleLink({ status: 'expired' as never })).success).toBe(false)
  })

  it('refuses a float amount', () => {
    expect(PaymentLinkSchema.safeParse(exampleLink({ amountKobo: 18500.5 })).success).toBe(false)
  })
})

describe('CreateLinkRequestSchema', () => {
  it('defaults to a single-use, open-amount, never-expiring link', () => {
    expect(CreateLinkRequestSchema.parse({ title: 'Ankara' })).toEqual({
      title: 'Ankara',
      amountKobo: null,
      isReusable: false,
      expiresAt: null,
    })
  })

  it('rejects an empty title, an over-long description and an amount below ₦100', () => {
    expect(CreateLinkRequestSchema.safeParse({ title: '   ' }).success).toBe(false)
    expect(CreateLinkRequestSchema.safeParse({ title: 'x', description: 'a'.repeat(501) }).success).toBe(false)
    expect(CreateLinkRequestSchema.safeParse({ title: 'x', amountKobo: 9_999 }).success).toBe(false)
  })

  it('does not let a client set counters, status or the merchant', () => {
    const parsed = CreateLinkRequestSchema.parse({
      title: 'x',
      paymentCount: 99,
      status: 'disabled',
      merchantId: 'someone-else',
    })
    expect(parsed).not.toHaveProperty('paymentCount')
    expect(parsed).not.toHaveProperty('status')
    expect(parsed).not.toHaveProperty('merchantId')
  })
})

describe('UpdateLinkStatusRequestSchema', () => {
  it('only toggles between active and disabled', () => {
    expect(UpdateLinkStatusRequestSchema.safeParse({ status: 'disabled' }).success).toBe(true)
    expect(UpdateLinkStatusRequestSchema.safeParse({ status: 'expired' }).success).toBe(false)
  })
})

describe('PublicLinkSchema — what a stranger may see', () => {
  const PRIVATE_FIELDS = ['merchantId', 'paymentCount', 'totalPaidKobo', 'status'] as const

  it('has no private field in its shape', () => {
    for (const field of PRIVATE_FIELDS) expect(PublicLinkSchema.shape).not.toHaveProperty(field)
  })

  it('toPublicLink strips every private field from the merchant view', () => {
    const pub = toPublicLink(exampleLink())
    for (const field of PRIVATE_FIELDS) expect(pub).not.toHaveProperty(field)
    expect(PublicLinkSchema.safeParse(pub).success).toBe(true)
  })

  it('the response carries a resolved state, never the raw stored status', () => {
    expect(PublicLinkResponseSchema.safeParse(examplePublicLinkResponse()).success).toBe(true)
    expect(PublicLinkResponseSchema.safeParse(examplePublicLinkResponse({ state: 'active' as never })).success).toBe(false)
    expect(PublicLinkResponseSchema.safeParse(examplePublicLinkResponse({ state: 'not-found' as never })).success).toBe(false)
  })
})
