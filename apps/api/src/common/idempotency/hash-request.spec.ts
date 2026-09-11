import { describe, expect, it } from 'vitest'
import { hashRequestBody } from './hash-request.js'

describe('hashRequestBody', () => {
  it('is stable across calls for the same value', () => {
    const body = { code: 'ABCD1234', amountKobo: 50_000, payerEmail: 'a@example.com' }
    expect(hashRequestBody(body)).toBe(hashRequestBody(body))
  })

  it('is the same hash regardless of key order — the same JSON body parses to both', () => {
    const first = { code: 'ABCD1234', amountKobo: 50_000 }
    const second = { amountKobo: 50_000, code: 'ABCD1234' }
    expect(hashRequestBody(first)).toBe(hashRequestBody(second))
  })

  it('differs when a value differs', () => {
    const first = { code: 'ABCD1234', amountKobo: 50_000 }
    const second = { code: 'ABCD1234', amountKobo: 50_001 }
    expect(hashRequestBody(first)).not.toBe(hashRequestBody(second))
  })

  it('differs between an empty object and an object with a null field — "no key" is not "null"', () => {
    expect(hashRequestBody({})).not.toBe(hashRequestBody({ note: null }))
  })

  it('is stable through nested objects and arrays regardless of nested key order', () => {
    const first = { items: [{ a: 1, b: 2 }], meta: { x: 'y' } }
    const second = { meta: { x: 'y' }, items: [{ b: 2, a: 1 }] }
    expect(hashRequestBody(first)).toBe(hashRequestBody(second))
  })

  it('tells apart values that JSON.stringify alone would not distinguish out of context', () => {
    // Same serialised array contents in a different position is still a different body.
    expect(hashRequestBody([1, 2, 3])).not.toBe(hashRequestBody([3, 2, 1]))
  })

  it('produces a 64-character lowercase hex sha256 digest', () => {
    expect(hashRequestBody({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a missing top-level body does not throw, and hashes the same as an explicit null', () => {
    expect(() => hashRequestBody(undefined)).not.toThrow()
    expect(hashRequestBody(undefined)).toBe(hashRequestBody(null))
  })

  it('an undefined-valued key is dropped, matching JSON.stringify — not rendered as the text "undefined"', () => {
    expect(hashRequestBody({ a: 1, b: undefined })).toBe(hashRequestBody({ a: 1 }))
    expect(hashRequestBody({ a: 1, b: undefined })).not.toBe(hashRequestBody({ a: 1, b: 'undefined' }))
  })

  it('an undefined array element becomes null, matching JSON.stringify — not rendered as the text "undefined"', () => {
    expect(hashRequestBody([1, undefined, 3])).toBe(hashRequestBody([1, null, 3]))
  })
})
