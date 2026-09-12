import { describe, expect, it } from 'vitest'
import { decodePaymentCursor, encodePaymentCursor } from './payment-cursor.js'

const REFERENCE = 'kbl_2A3b4C5d6E'

describe('encodePaymentCursor / decodePaymentCursor', () => {
  it('round-trips createdAt and reference exactly', () => {
    const createdAt = new Date('2026-09-01T12:00:00.000Z')
    const cursor = encodePaymentCursor(createdAt, REFERENCE)

    const decoded = decodePaymentCursor(cursor)

    expect(decoded).toBeDefined()
    expect(decoded?.createdAt.toISOString()).toBe(createdAt.toISOString())
    expect(decoded?.reference).toBe(REFERENCE)
  })

  it('is opaque base64url, not a readable string', () => {
    const cursor = encodePaymentCursor(new Date('2026-09-01T12:00:00.000Z'), REFERENCE)
    expect(cursor).not.toContain(REFERENCE)
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('rejects a cursor that is not valid base64url JSON', () => {
    expect(decodePaymentCursor('not-a-cursor-at-all-!!!')).toBeUndefined()
  })

  it('rejects valid base64url that decodes to something other than an object', () => {
    const cursor = Buffer.from('"just a string"', 'utf8').toString('base64url')
    expect(decodePaymentCursor(cursor)).toBeUndefined()
  })

  it('rejects a payload missing createdAt or reference', () => {
    const missingReference = Buffer.from(JSON.stringify({ createdAt: '2026-09-01T12:00:00.000Z' }), 'utf8').toString(
      'base64url',
    )
    expect(decodePaymentCursor(missingReference)).toBeUndefined()

    const missingCreatedAt = Buffer.from(JSON.stringify({ reference: REFERENCE }), 'utf8').toString('base64url')
    expect(decodePaymentCursor(missingCreatedAt)).toBeUndefined()
  })

  it('rejects a payload whose reference is not a valid payment reference', () => {
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: '2026-09-01T12:00:00.000Z', reference: 'not-a-reference' }),
      'utf8',
    ).toString('base64url')
    expect(decodePaymentCursor(cursor)).toBeUndefined()
  })

  it('rejects a payload whose reference is a valid link code instead (8 chars, no kbl_ prefix)', () => {
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: '2026-09-01T12:00:00.000Z', reference: 'KBLDEMX2' }),
      'utf8',
    ).toString('base64url')
    expect(decodePaymentCursor(cursor)).toBeUndefined()
  })

  it('rejects a payload whose createdAt is not a parseable date', () => {
    const cursor = Buffer.from(JSON.stringify({ createdAt: 'not-a-date', reference: REFERENCE }), 'utf8').toString(
      'base64url',
    )
    expect(decodePaymentCursor(cursor)).toBeUndefined()
  })

  it('never throws on arbitrary garbage input', () => {
    for (const garbage of ['', '!!!', '====', Buffer.from('[1,2,3]').toString('base64url')]) {
      expect(() => decodePaymentCursor(garbage)).not.toThrow()
    }
  })
})
