import { describe, expect, it } from 'vitest'
import { getClientIp } from './client-ip.js'

describe('getClientIp', () => {
  it('uses the socket address when X-Forwarded-For is absent', () => {
    expect(getClientIp({ forwardedFor: undefined, remoteAddress: '203.0.113.4', trustProxy: true })).toBe(
      '203.0.113.4',
    )
  })

  it('ignores X-Forwarded-For when trustProxy is false — an untrusted client could otherwise forge it', () => {
    expect(getClientIp({ forwardedFor: '198.51.100.1', remoteAddress: '203.0.113.4', trustProxy: false })).toBe(
      '203.0.113.4',
    )
  })

  it('takes the first (client) hop of X-Forwarded-For when trustProxy is true', () => {
    expect(
      getClientIp({ forwardedFor: '198.51.100.1, 10.0.0.1, 10.0.0.2', remoteAddress: '10.0.0.2', trustProxy: true }),
    ).toBe('198.51.100.1')
  })

  it('trims whitespace around the first hop', () => {
    expect(getClientIp({ forwardedFor: '  198.51.100.1  , 10.0.0.1', remoteAddress: '10.0.0.1', trustProxy: true })).toBe(
      '198.51.100.1',
    )
  })

  it('falls back to the socket address when trustProxy is true but the header is empty', () => {
    expect(getClientIp({ forwardedFor: '', remoteAddress: '203.0.113.4', trustProxy: true })).toBe('203.0.113.4')
  })

  it('returns "unknown" when neither is available', () => {
    expect(getClientIp({ forwardedFor: undefined, remoteAddress: undefined, trustProxy: true })).toBe('unknown')
  })
})
