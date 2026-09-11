import { describe, expect, it } from 'vitest'
import { extractToken } from './extract-token.js'

describe('extractToken', () => {
  it('reads the token from the session cookie', () => {
    expect(
      extractToken({ cookies: { kobolink_session: 'cookie-token' }, authorizationHeader: undefined }),
    ).toBe('cookie-token')
  })

  it('reads the token from a Bearer authorization header', () => {
    expect(extractToken({ cookies: undefined, authorizationHeader: 'Bearer mobile-token' })).toBe('mobile-token')
  })

  it('prefers the bearer header when both are present', () => {
    expect(
      extractToken({
        cookies: { kobolink_session: 'cookie-token' },
        authorizationHeader: 'Bearer mobile-token',
      }),
    ).toBe('mobile-token')
  })

  it('returns undefined when neither is present', () => {
    expect(extractToken({ cookies: undefined, authorizationHeader: undefined })).toBeUndefined()
  })

  it('returns undefined for a non-Bearer authorization scheme', () => {
    expect(extractToken({ cookies: undefined, authorizationHeader: 'Basic dXNlcjpwYXNz' })).toBeUndefined()
  })

  it('returns undefined for an empty Bearer token', () => {
    expect(extractToken({ cookies: undefined, authorizationHeader: 'Bearer ' })).toBeUndefined()
  })

  it('returns undefined for an empty cookie value', () => {
    expect(extractToken({ cookies: { kobolink_session: '' }, authorizationHeader: undefined })).toBeUndefined()
  })

  it('ignores an unrelated cookie', () => {
    expect(extractToken({ cookies: { other: 'value' }, authorizationHeader: undefined })).toBeUndefined()
  })
})
