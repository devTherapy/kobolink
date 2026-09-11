import { IdSchema } from '@kobolink/contracts'
import { describe, expect, it } from 'vitest'
import { generateSessionId, generateSessionToken, hashSessionToken } from './session-token.js'

describe('generateSessionId', () => {
  it('satisfies the contract IdSchema', () => {
    const id = generateSessionId()
    expect(IdSchema.safeParse(id).success).toBe(true)
  })

  it('is 22 characters — log2(64) * 22 ≈ 132 bits, above the ≥128-bit floor', () => {
    expect(generateSessionId()).toHaveLength(22)
  })

  it('is different on every call', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateSessionId()))
    expect(ids.size).toBe(50)
  })
})

describe('generateSessionToken', () => {
  it('decodes to exactly 32 bytes — 256 bits', () => {
    const token = generateSessionToken()
    const decoded = Buffer.from(token, 'base64url')
    expect(decoded).toHaveLength(32)
  })

  it('is URL-safe (no +, /, or = padding)', () => {
    const token = generateSessionToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('is different on every call', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateSessionToken()))
    expect(tokens.size).toBe(50)
  })
})

describe('hashSessionToken', () => {
  it('is a 64-character hex digest — matches sessions.token_hash’s varchar(64)', () => {
    expect(hashSessionToken('some-token')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for the same input', () => {
    expect(hashSessionToken('same-token')).toBe(hashSessionToken('same-token'))
  })

  it('differs for different input', () => {
    expect(hashSessionToken('token-a')).not.toBe(hashSessionToken('token-b'))
  })
})
