import { describe, expect, it } from 'vitest'
import {
  InitializeCheckoutRequestSchema,
  PaymentSchema,
  VerifyCheckoutRequestSchema,
  examplePayment,
  isSimulatedDecline,
  maskEmail,
} from '../src/index.js'

describe('InitializeCheckoutRequestSchema', () => {
  const good = { code: 'aBcDeFgH', amountKobo: 1_850_000, payerName: 'Ngozi', payerEmail: 'ngozi@example.com' }

  it('accepts a complete request and lowercases the email', () => {
    expect(InitializeCheckoutRequestSchema.parse({ ...good, payerEmail: 'Ngozi@Example.com' }).payerEmail).toBe(
      'ngozi@example.com',
    )
  })

  it('accepts 18500.0 (an integer in JS) but rejects a real float, a string amount, a bad code and a bad email', () => {
    expect(InitializeCheckoutRequestSchema.safeParse({ ...good, amountKobo: 18500.0 }).success).toBe(true)
    expect(InitializeCheckoutRequestSchema.safeParse({ ...good, amountKobo: 18500.5 }).success).toBe(false)
    expect(InitializeCheckoutRequestSchema.safeParse({ ...good, amountKobo: '1850000' }).success).toBe(false)
    expect(InitializeCheckoutRequestSchema.safeParse({ ...good, code: 'abcdefg0' }).success).toBe(false)
    expect(InitializeCheckoutRequestSchema.safeParse({ ...good, payerEmail: 'nope' }).success).toBe(false)
  })

  it('has no field through which a client could claim success', () => {
    expect(InitializeCheckoutRequestSchema.shape).not.toHaveProperty('status')
    expect(InitializeCheckoutRequestSchema.shape).not.toHaveProperty('reference')
    expect(VerifyCheckoutRequestSchema.shape).not.toHaveProperty('status')
    expect(VerifyCheckoutRequestSchema.shape).not.toHaveProperty('amountKobo')
  })
})

describe('PaymentSchema', () => {
  it('accepts the fixture and rejects an unknown status', () => {
    expect(PaymentSchema.safeParse(examplePayment()).success).toBe(true)
    expect(PaymentSchema.safeParse(examplePayment({ status: 'refunded' as never })).success).toBe(false)
  })

  it('a declined payment is a normal outcome that says money did not move', () => {
    const declined = examplePayment({ status: 'failed', failureReason: 'Card declined by issuer', completedAt: null })
    expect(declined.moneyMoved).toBe(false)
    expect(PaymentSchema.safeParse(declined).success).toBe(true)
  })

  it('refuses a payment whose moneyMoved contradicts its status — the invariant the result screens rely on', () => {
    expect(PaymentSchema.safeParse(examplePayment({ status: 'failed', moneyMoved: true })).success).toBe(false)
    expect(PaymentSchema.safeParse(examplePayment({ status: 'success', moneyMoved: false })).success).toBe(false)
    expect(PaymentSchema.safeParse(examplePayment({ status: 'pending', moneyMoved: true })).success).toBe(false)
  })
})

describe('isSimulatedDecline', () => {
  it('declines only the fail@ prefix, case-insensitively', () => {
    expect(isSimulatedDecline('fail@example.com')).toBe(true)
    expect(isSimulatedDecline('  FAIL@example.com')).toBe(true)
    expect(isSimulatedDecline('failure@example.com')).toBe(false)
    expect(isSimulatedDecline('ok@fail.com')).toBe(false)
  })
})

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    expect(maskEmail('ngozi@example.com')).toBe('n***@example.com')
    expect(maskEmail('@example.com')).toBe('***')
    expect(maskEmail('garbage')).toBe('***')
  })
})
