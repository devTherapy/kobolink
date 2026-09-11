import { describe, expect, it } from 'vitest'
import {
  AmountKoboSchema,
  IdempotencyKeySchema,
  KoboSchema,
  LinkCodeSchema,
  MAX_AMOUNT_KOBO,
  MIN_AMOUNT_KOBO,
  PageQuerySchema,
  PaymentReferenceSchema,
  PhoneSchema,
  newLinkCode,
  newPaymentReference,
} from '../src/index.js'

describe('KoboSchema / AmountKoboSchema', () => {
  it('refuses a float — money is an integer number of kobo', () => {
    expect(KoboSchema.safeParse(1850.5).success).toBe(false)
    expect(AmountKoboSchema.safeParse(1850.5).success).toBe(false)
    expect(KoboSchema.safeParse(185000).success).toBe(true)
  })

  it('refuses a numeric string — no coercion on money', () => {
    expect(AmountKoboSchema.safeParse('185000').success).toBe(false)
  })

  it('bounds a chargeable amount to the same limits as isValidAmountKobo', () => {
    expect(AmountKoboSchema.safeParse(MIN_AMOUNT_KOBO).success).toBe(true)
    expect(AmountKoboSchema.safeParse(MIN_AMOUNT_KOBO - 1).success).toBe(false)
    expect(AmountKoboSchema.safeParse(MAX_AMOUNT_KOBO).success).toBe(true)
    expect(AmountKoboSchema.safeParse(MAX_AMOUNT_KOBO + 1).success).toBe(false)
    expect(AmountKoboSchema.safeParse(-100).success).toBe(false)
  })
})

describe('LinkCodeSchema', () => {
  it('accepts generated codes and rejects mistranscribable ones', () => {
    expect(LinkCodeSchema.safeParse(newLinkCode()).success).toBe(true)
    expect(LinkCodeSchema.safeParse('abcdefg0').success).toBe(false)
    expect(LinkCodeSchema.safeParse('abcdefgO').success).toBe(false)
    expect(LinkCodeSchema.safeParse('short').success).toBe(false)
    expect(LinkCodeSchema.safeParse('../etc/pw').success).toBe(false)
  })
})

describe('PaymentReferenceSchema', () => {
  it('accepts what newPaymentReference produces and nothing looser', () => {
    expect(PaymentReferenceSchema.safeParse(newPaymentReference()).success).toBe(true)
    expect(PaymentReferenceSchema.safeParse('kbl_short').success).toBe(false)
    expect(PaymentReferenceSchema.safeParse('ref_7hK2mN9pQr').success).toBe(false)
  })
})

describe('PhoneSchema', () => {
  it.each([
    ['08031234567', '+2348031234567'],
    ['0803 123 4567', '+2348031234567'],
    ['2348031234567', '+2348031234567'],
    ['+2348031234567', '+2348031234567'],
    ['+234-703-123-4567', '+2347031234567'],
    ['09012345678', '+2349012345678'],
  ])('normalises %s to %s', (input, expected) => {
    expect(PhoneSchema.parse(input)).toBe(expected)
  })

  it.each(['0123456789', '080312345', '+14155551212', 'abc', ''])('rejects %s', (input) => {
    expect(PhoneSchema.safeParse(input).success).toBe(false)
  })
})

describe('IdempotencyKeySchema', () => {
  it('requires enough entropy to be a real key', () => {
    expect(IdempotencyKeySchema.safeParse('abc').success).toBe(false)
    expect(IdempotencyKeySchema.safeParse('a'.repeat(16)).success).toBe(true)
    expect(IdempotencyKeySchema.safeParse('has spaces in it and more').success).toBe(false)
  })
})

describe('PageQuerySchema', () => {
  it('coerces the limit from a query string and bounds it', () => {
    expect(PageQuerySchema.parse({})).toEqual({ limit: 20 })
    expect(PageQuerySchema.parse({ limit: '50', cursor: 'abc' })).toEqual({ limit: 50, cursor: 'abc' })
    expect(PageQuerySchema.safeParse({ limit: '500' }).success).toBe(false)
    expect(PageQuerySchema.safeParse({ limit: '0' }).success).toBe(false)
  })
})
