import { describe, expect, it } from 'vitest'
import { RateLimiterService } from './rate-limiter.service.js'

describe('RateLimiterService', () => {
  it('allows the first attempt for a fresh email/ip pair', () => {
    const limiter = new RateLimiterService()
    expect(limiter.check('a@example.com', '1.1.1.1', 0)).toEqual({ allowed: true, retryAfterSeconds: 0 })
  })

  it('trips the email bucket after 5 recorded failures, independent of IP', () => {
    const limiter = new RateLimiterService()
    const now = 0
    for (let i = 0; i < 5; i++) limiter.recordFailure('a@example.com', `1.1.1.${i}`, now + i)

    expect(limiter.check('a@example.com', '9.9.9.9', now + 10).allowed).toBe(false)
  })

  it('trips the IP bucket after 20 recorded failures, independent of email', () => {
    const limiter = new RateLimiterService()
    const now = 0
    for (let i = 0; i < 20; i++) limiter.recordFailure(`user${i}@example.com`, '1.1.1.1', now + i)

    expect(limiter.check('someone-else@example.com', '1.1.1.1', now + 30).allowed).toBe(false)
  })

  it('does not trip below the threshold', () => {
    const limiter = new RateLimiterService()
    const now = 0
    for (let i = 0; i < 4; i++) limiter.recordFailure('a@example.com', '1.1.1.1', now + i)

    expect(limiter.check('a@example.com', '1.1.1.1', now + 10).allowed).toBe(true)
  })

  it('resetEmail clears the email bucket but leaves the IP bucket alone', () => {
    const limiter = new RateLimiterService()
    const now = 0
    for (let i = 0; i < 5; i++) limiter.recordFailure('a@example.com', '1.1.1.1', now + i)
    limiter.resetEmail('a@example.com')

    expect(limiter.check('a@example.com', '1.1.1.1', now + 10).allowed).toBe(true)

    // The IP bucket still has 5 failures on it — push 15 more from a
    // different email to reach the 20-failure IP threshold and prove the
    // reset was scoped to the email only.
    for (let i = 5; i < 20; i++) limiter.recordFailure('b@example.com', '1.1.1.1', now + i)
    expect(limiter.check('c@example.com', '1.1.1.1', now + 30).allowed).toBe(false)
  })

  it('a failure outside the 15-minute window no longer counts', () => {
    const limiter = new RateLimiterService()
    const windowMs = 15 * 60 * 1000
    for (let i = 0; i < 5; i++) limiter.recordFailure('a@example.com', '1.1.1.1', i)

    expect(limiter.check('a@example.com', '1.1.1.1', windowMs + 1).allowed).toBe(true)
  })
})
