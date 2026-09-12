import { describe, expect, it } from 'vitest'
import { decodeWalletCursor, encodeWalletCursor } from './wallet-cursor.js'

describe('encodeWalletCursor / decodeWalletCursor', () => {
  it('round-trips createdAt and entryId exactly', () => {
    const createdAt = new Date('2026-09-01T12:00:00.000Z')
    const cursor = encodeWalletCursor(createdAt, 'V1StGXR8_Z5jdHi6B-myT')

    const decoded = decodeWalletCursor(cursor)

    expect(decoded).toBeDefined()
    expect(decoded?.createdAt.toISOString()).toBe(createdAt.toISOString())
    expect(decoded?.entryId).toBe('V1StGXR8_Z5jdHi6B-myT')
  })

  it('is opaque base64url, not a readable string', () => {
    const cursor = encodeWalletCursor(new Date('2026-09-01T12:00:00.000Z'), 'V1StGXR8_Z5jdHi6B-myT')
    expect(cursor).not.toContain('V1StGXR8_Z5jdHi6B-myT')
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('rejects a cursor that is not valid base64url JSON', () => {
    expect(decodeWalletCursor('not-a-cursor-at-all-!!!')).toBeUndefined()
  })

  it('rejects valid base64url that decodes to something other than an object', () => {
    const cursor = Buffer.from('"just a string"', 'utf8').toString('base64url')
    expect(decodeWalletCursor(cursor)).toBeUndefined()
  })

  it('rejects a payload missing createdAt or entryId', () => {
    const missingEntryId = Buffer.from(JSON.stringify({ createdAt: '2026-09-01T12:00:00.000Z' }), 'utf8').toString('base64url')
    expect(decodeWalletCursor(missingEntryId)).toBeUndefined()

    const missingCreatedAt = Buffer.from(JSON.stringify({ entryId: 'abc123' }), 'utf8').toString('base64url')
    expect(decodeWalletCursor(missingCreatedAt)).toBeUndefined()
  })

  it('rejects a payload whose entryId is not a plausible opaque id', () => {
    const cursor = Buffer.from(JSON.stringify({ createdAt: '2026-09-01T12:00:00.000Z', entryId: 'has a space' }), 'utf8').toString(
      'base64url',
    )
    expect(decodeWalletCursor(cursor)).toBeUndefined()
  })

  it('rejects a payload whose createdAt is not a parseable date', () => {
    const cursor = Buffer.from(JSON.stringify({ createdAt: 'not-a-date', entryId: 'abc123' }), 'utf8').toString('base64url')
    expect(decodeWalletCursor(cursor)).toBeUndefined()
  })

  it('never throws on arbitrary garbage input', () => {
    for (const garbage of ['', '!!!', '====', Buffer.from('[1,2,3]').toString('base64url')]) {
      expect(() => decodeWalletCursor(garbage)).not.toThrow()
    }
  })
})
