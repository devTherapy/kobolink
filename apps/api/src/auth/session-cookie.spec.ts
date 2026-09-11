import { describe, expect, it } from 'vitest'
import {
  buildClearCookieOptions,
  buildSessionCookieOptions,
  isDevelopmentEnv,
  SESSION_LIFETIME_MS,
} from './session-cookie.js'

describe('isDevelopmentEnv', () => {
  it('is true only for the literal string "development"', () => {
    expect(isDevelopmentEnv('development')).toBe(true)
    expect(isDevelopmentEnv('production')).toBe(false)
    expect(isDevelopmentEnv('test')).toBe(false)
    expect(isDevelopmentEnv(undefined)).toBe(false)
  })
})

describe('buildSessionCookieOptions', () => {
  it('is httpOnly, SameSite=Lax, Path=/ and carries the 30-day Max-Age regardless of environment', () => {
    for (const env of ['development', 'production', 'test', undefined]) {
      const options = buildSessionCookieOptions(env)
      expect(options.httpOnly).toBe(true)
      expect(options.sameSite).toBe('lax')
      expect(options.path).toBe('/')
      expect(options.maxAge).toBe(SESSION_LIFETIME_MS)
      expect(options.maxAge).toBe(30 * 24 * 60 * 60 * 1000)
    }
  })

  it('is Secure outside development', () => {
    expect(buildSessionCookieOptions('production').secure).toBe(true)
    expect(buildSessionCookieOptions('test').secure).toBe(true)
    expect(buildSessionCookieOptions(undefined).secure).toBe(true)
  })

  it('is not Secure in development — a plain-HTTP local server cannot set one', () => {
    expect(buildSessionCookieOptions('development').secure).toBe(false)
  })
})

describe('buildClearCookieOptions', () => {
  it('matches the Path (and Secure/SameSite) the cookie was set with, so a browser actually clears it', () => {
    const set = buildSessionCookieOptions('production')
    const cleared = buildClearCookieOptions('production')
    expect(cleared.path).toBe(set.path)
    expect(cleared.secure).toBe(set.secure)
    expect(cleared.sameSite).toBe(set.sameSite)
    expect(cleared.httpOnly).toBe(set.httpOnly)
  })

  it('carries no maxAge', () => {
    expect('maxAge' in buildClearCookieOptions('production')).toBe(false)
  })
})
