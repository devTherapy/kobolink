import { describe, expect, it } from 'vitest'
import { parseDashboardNotification } from './dashboard-notification.js'

describe('parseDashboardNotification', () => {
  it('parses a well-formed payload', () => {
    expect(parseDashboardNotification('{"table":"postings","id":"pst_abc123"}')).toEqual({
      table: 'postings',
      id: 'pst_abc123',
    })
  })

  it('returns undefined for an undefined payload (pg sends no payload on some notifications)', () => {
    expect(parseDashboardNotification(undefined)).toBeUndefined()
  })

  it('returns undefined for invalid JSON rather than throwing', () => {
    expect(() => parseDashboardNotification('not json')).not.toThrow()
    expect(parseDashboardNotification('not json')).toBeUndefined()
  })

  it('returns undefined for JSON that is not an object', () => {
    expect(parseDashboardNotification('"just a string"')).toBeUndefined()
    expect(parseDashboardNotification('42')).toBeUndefined()
    expect(parseDashboardNotification('null')).toBeUndefined()
  })

  it('returns undefined when table is missing or not a string', () => {
    expect(parseDashboardNotification('{"id":"pst_abc123"}')).toBeUndefined()
    expect(parseDashboardNotification('{"table":1,"id":"pst_abc123"}')).toBeUndefined()
  })

  it('returns undefined when id is missing or not a string', () => {
    expect(parseDashboardNotification('{"table":"postings"}')).toBeUndefined()
    expect(parseDashboardNotification('{"table":"postings","id":123}')).toBeUndefined()
  })

  it('ignores extra fields rather than rejecting them', () => {
    expect(parseDashboardNotification('{"table":"postings","id":"pst_abc123","extra":true}')).toEqual({
      table: 'postings',
      id: 'pst_abc123',
    })
  })
})
