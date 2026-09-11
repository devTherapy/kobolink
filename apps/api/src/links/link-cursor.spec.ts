import { describe, expect, it } from 'vitest'
import { decodeLinkCursor, encodeLinkCursor } from './link-cursor.js'

describe('encodeLinkCursor / decodeLinkCursor', () => {
  it('round-trips createdAt and code exactly', () => {
    const createdAt = new Date('2026-09-01T12:00:00.000Z')
    const cursor = encodeLinkCursor(createdAt, 'KBLDEMX2')

    const decoded = decodeLinkCursor(cursor)

    expect(decoded).toBeDefined()
    expect(decoded?.createdAt.toISOString()).toBe(createdAt.toISOString())
    expect(decoded?.code).toBe('KBLDEMX2')
  })

  it('is opaque base64url, not a readable string', () => {
    const cursor = encodeLinkCursor(new Date('2026-09-01T12:00:00.000Z'), 'KBLDEMX2')
    expect(cursor).not.toContain('KBLDEMX2')
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('rejects a cursor that is not valid base64url JSON', () => {
    expect(decodeLinkCursor('not-a-cursor-at-all-!!!')).toBeUndefined()
  })

  it('rejects valid base64url that decodes to something other than an object', () => {
    const cursor = Buffer.from('"just a string"', 'utf8').toString('base64url')
    expect(decodeLinkCursor(cursor)).toBeUndefined()
  })

  it('rejects a payload missing createdAt or code', () => {
    const missingCode = Buffer.from(JSON.stringify({ createdAt: '2026-09-01T12:00:00.000Z' }), 'utf8').toString(
      'base64url',
    )
    expect(decodeLinkCursor(missingCode)).toBeUndefined()

    const missingCreatedAt = Buffer.from(JSON.stringify({ code: 'KBLDEMX2' }), 'utf8').toString('base64url')
    expect(decodeLinkCursor(missingCreatedAt)).toBeUndefined()
  })

  it('rejects a payload whose code is not a valid link code', () => {
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: '2026-09-01T12:00:00.000Z', code: 'not-a-code' }),
      'utf8',
    ).toString('base64url')
    expect(decodeLinkCursor(cursor)).toBeUndefined()
  })

  it('rejects a payload whose createdAt is not a parseable date', () => {
    const cursor = Buffer.from(JSON.stringify({ createdAt: 'not-a-date', code: 'KBLDEMX2' }), 'utf8').toString(
      'base64url',
    )
    expect(decodeLinkCursor(cursor)).toBeUndefined()
  })

  it('never throws on arbitrary garbage input', () => {
    for (const garbage of ['', '!!!', '====', Buffer.from('[1,2,3]').toString('base64url')]) {
      expect(() => decodeLinkCursor(garbage)).not.toThrow()
    }
  })
})
