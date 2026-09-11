import { describe, expect, it } from 'vitest'
import {
  formatNaira, parseNaira, isValidAmountKobo, MIN_AMOUNT_KOBO, MAX_AMOUNT_KOBO,
} from '@/lib/money'

describe('formatNaira', () => {
  it('renders whole naira without a decimal part', () => {
    expect(formatNaira(1_850_000)).toBe('₦18,500')
    expect(formatNaira(0)).toBe('₦0')
  })

  it('shows kobo only when there is a remainder', () => {
    expect(formatNaira(1_850_050)).toBe('₦18,500.50')
    expect(formatNaira(1_850_005)).toBe('₦18,500.05')
    expect(formatNaira(1_850_000, { kobo: true })).toBe('₦18,500.00')
  })

  it('handles negatives', () => {
    expect(formatNaira(-1_850_000)).toBe('-₦18,500')
  })

  it('refuses a float rather than silently rounding it', () => {
    expect(() => formatNaira(1850.5)).toThrow(TypeError)
  })
})

describe('parseNaira', () => {
  it.each([
    ['18500', 1_850_000],
    ['18,500', 1_850_000],
    ['₦18,500', 1_850_000],
    [' ₦18,500 ', 1_850_000],
    ['18500.5', 1_850_050],
    ['18500.05', 1_850_005],
    ['0', 0],
  ])('parses %s', (input, expected) => {
    expect(parseNaira(input)).toBe(expected)
  })

  it.each(['', 'abc', '18,50 0.123', '1.2.3', '₦', '18500.123', '--5'])(
    'rejects %s rather than guessing',
    (input) => { expect(parseNaira(input)).toBeNull() },
  )

  it('round-trips through formatNaira', () => {
    for (const kobo of [0, 100, 1_850_000, 1_850_050, 999_999_99]) {
      expect(parseNaira(formatNaira(kobo, { kobo: true }))).toBe(kobo)
    }
  })
})

describe('isValidAmountKobo', () => {
  it('accepts the boundaries', () => {
    expect(isValidAmountKobo(MIN_AMOUNT_KOBO)).toBe(true)
    expect(isValidAmountKobo(MAX_AMOUNT_KOBO)).toBe(true)
  })
  it('rejects outside them, and rejects floats', () => {
    expect(isValidAmountKobo(MIN_AMOUNT_KOBO - 1)).toBe(false)
    expect(isValidAmountKobo(MAX_AMOUNT_KOBO + 1)).toBe(false)
    expect(isValidAmountKobo(10_000.5)).toBe(false)
  })
})
