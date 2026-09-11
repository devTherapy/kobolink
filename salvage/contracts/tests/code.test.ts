import { describe, expect, it } from 'vitest'
import { CODE_LENGTH, isValidLinkCode, newLinkCode, newPaymentReference } from '@/lib/code'

describe('newLinkCode', () => {
  it('is the declared length and passes its own validator', () => {
    for (let i = 0; i < 200; i++) {
      const code = newLinkCode()
      expect(code).toHaveLength(CODE_LENGTH)
      expect(isValidLinkCode(code)).toBe(true)
    }
  })

  it('omits the characters people mistranscribe', () => {
    const sample = Array.from({ length: 500 }, newLinkCode).join('')
    for (const ch of ['0', 'O', '1', 'l', 'I']) expect(sample).not.toContain(ch)
  })

  it('does not collide across a realistic batch', () => {
    const codes = new Set(Array.from({ length: 5000 }, newLinkCode))
    expect(codes.size).toBe(5000)
  })
})

describe('isValidLinkCode', () => {
  it('rejects wrong length and out-of-alphabet input', () => {
    expect(isValidLinkCode('short')).toBe(false)
    expect(isValidLinkCode('waytoolongcode')).toBe(false)
    expect(isValidLinkCode('abcdefg0')).toBe(false)   // contains 0
    expect(isValidLinkCode('abcdef-g')).toBe(false)   // path separator-ish
    expect(isValidLinkCode('')).toBe(false)
  })
})

describe('newPaymentReference', () => {
  it('carries the readable prefix payers quote back', () => {
    expect(newPaymentReference()).toMatch(/^kbl_[2-9A-HJ-NP-Za-km-z]{10}$/)
  })
})
