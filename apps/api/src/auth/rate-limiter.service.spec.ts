import { afterEach, describe, expect, it } from 'vitest'
import { RateLimiterService } from './rate-limiter.service.js'

describe('RateLimiterService', () => {
  let limiter: RateLimiterService | undefined

  afterEach(() => {
    limiter?.onModuleDestroy()
    limiter = undefined
  })

  function newLimiter(options?: ConstructorParameters<typeof RateLimiterService>[0]): RateLimiterService {
    limiter = new RateLimiterService(options)
    return limiter
  }

  describe('tryAcquireLogin', () => {
    it('allows the first attempt for a fresh email/ip pair and reserves it', () => {
      const rateLimiter = newLimiter()
      expect(rateLimiter.tryAcquireLogin('a@example.com', '1.1.1.1', 0)).toEqual({ allowed: true, retryAfterSeconds: 0 })
      expect(rateLimiter.emailBucketSizeForTesting()).toBe(1)
      expect(rateLimiter.ipBucketSizeForTesting()).toBe(1)
    })

    it('trips the email bucket after 5 admitted attempts, independent of IP', () => {
      const rateLimiter = newLimiter()
      const now = 0
      for (let i = 0; i < 5; i++) rateLimiter.tryAcquireLogin('a@example.com', `1.1.1.${i}`, now + i)

      expect(rateLimiter.tryAcquireLogin('a@example.com', '9.9.9.9', now + 10).allowed).toBe(false)
    })

    it('trips the IP bucket after 20 admitted attempts, independent of email', () => {
      const rateLimiter = newLimiter()
      const now = 0
      for (let i = 0; i < 20; i++) rateLimiter.tryAcquireLogin(`user${i}@example.com`, '1.1.1.1', now + i)

      expect(rateLimiter.tryAcquireLogin('someone-else@example.com', '1.1.1.1', now + 30).allowed).toBe(false)
    })

    it('does not trip below the threshold', () => {
      const rateLimiter = newLimiter()
      const now = 0
      for (let i = 0; i < 4; i++) rateLimiter.tryAcquireLogin('a@example.com', '1.1.1.1', now + i)

      expect(rateLimiter.tryAcquireLogin('a@example.com', '1.1.1.1', now + 10).allowed).toBe(true)
    })

    it('a blocked attempt reserves neither bucket', () => {
      const rateLimiter = newLimiter()
      const now = 0
      for (let i = 0; i < 5; i++) rateLimiter.tryAcquireLogin('a@example.com', '1.1.1.1', now + i)
      expect(rateLimiter.ipBucketSizeForTesting()).toBe(1)

      // Blocked by the email bucket — must not also grow the IP bucket's
      // stored timestamp count for 1.1.1.1.
      rateLimiter.tryAcquireLogin('a@example.com', '1.1.1.1', now + 10)
      rateLimiter.resetEmail('a@example.com')
      // If the blocked attempt above had still reserved the IP slot, this
      // fresh email would now see 6 IP-bucket entries instead of 5.
      for (let i = 0; i < 14; i++) rateLimiter.tryAcquireLogin(`other${i}@example.com`, '1.1.1.1', now + 20 + i)
      // 5 (first email's admitted attempts) + 14 = 19, still under 20.
      expect(rateLimiter.tryAcquireLogin('yet-another@example.com', '1.1.1.1', now + 40).allowed).toBe(true)
    })

    it('resetEmail clears the email bucket but leaves the IP bucket alone', () => {
      const rateLimiter = newLimiter()
      const now = 0
      for (let i = 0; i < 5; i++) rateLimiter.tryAcquireLogin('a@example.com', '1.1.1.1', now + i)
      rateLimiter.resetEmail('a@example.com')

      expect(rateLimiter.tryAcquireLogin('a@example.com', '1.1.1.1', now + 10).allowed).toBe(true)

      // The IP bucket still has 5 entries on it (the first email's own 5
      // admitted attempts) — push 14 more from a different email to reach
      // the 20-attempt IP threshold and prove the reset was scoped to the
      // email only.
      for (let i = 5; i < 19; i++) rateLimiter.tryAcquireLogin(`b${i}@example.com`, '1.1.1.1', now + i)
      expect(rateLimiter.tryAcquireLogin('c@example.com', '1.1.1.1', now + 30).allowed).toBe(false)
    })

    it('an attempt outside the 15-minute window no longer counts', () => {
      const rateLimiter = newLimiter()
      const windowMs = 15 * 60 * 1000
      for (let i = 0; i < 5; i++) rateLimiter.tryAcquireLogin('a@example.com', '1.1.1.1', i)

      expect(rateLimiter.tryAcquireLogin('a@example.com', '1.1.1.1', windowMs + 1).allowed).toBe(true)
    })
  })

  describe('tryAcquireIp', () => {
    it('shares the same IP bucket tryAcquireLogin uses', () => {
      const rateLimiter = newLimiter()
      const now = 0
      for (let i = 0; i < 15; i++) rateLimiter.tryAcquireIp('1.1.1.1', now + i)
      for (let i = 0; i < 5; i++) rateLimiter.tryAcquireLogin(`user${i}@example.com`, '1.1.1.1', now + 20 + i)

      // 15 (register) + 5 (login) = 20 — the shared bucket is now full.
      expect(rateLimiter.tryAcquireIp('1.1.1.1', now + 30).allowed).toBe(false)
      expect(rateLimiter.tryAcquireLogin('fresh@example.com', '1.1.1.1', now + 30).allowed).toBe(false)
    })

    it('trips after 20 admitted attempts', () => {
      const rateLimiter = newLimiter()
      for (let i = 0; i < 20; i++) rateLimiter.tryAcquireIp('2.2.2.2', i)

      expect(rateLimiter.tryAcquireIp('2.2.2.2', 30).allowed).toBe(false)
    })
  })

  describe('sweep', () => {
    it('deletes a key whose entire window has aged out', () => {
      const rateLimiter = newLimiter()
      rateLimiter.tryAcquireIp('3.3.3.3', 0)
      expect(rateLimiter.ipBucketSizeForTesting()).toBe(1)

      rateLimiter.sweep(15 * 60 * 1000 + 1)
      expect(rateLimiter.ipBucketSizeForTesting()).toBe(0)
    })

    it('leaves a key with at least one surviving timestamp alone (pruned in place, not deleted)', () => {
      const rateLimiter = newLimiter()
      rateLimiter.tryAcquireIp('4.4.4.4', 0)
      rateLimiter.tryAcquireIp('4.4.4.4', 10 * 60 * 1000)

      rateLimiter.sweep(15 * 60 * 1000 + 1)
      expect(rateLimiter.ipBucketSizeForTesting()).toBe(1)
      // The surviving (10-minute-old) timestamp still counts toward the
      // limit — 1 survivor + 19 more reaches the 20-attempt limit exactly,
      // so this 20th-total call is the one that trips it.
      for (let i = 0; i < 19; i++) rateLimiter.tryAcquireIp('4.4.4.4', 15 * 60 * 1000 + 2 + i)
      expect(rateLimiter.tryAcquireIp('4.4.4.4', 15 * 60 * 1000 + 100).allowed).toBe(false)
    })

    it('runs automatically on its own interval, evicting a fully-aged-out key with no direct sweep() call', async () => {
      const rateLimiter = newLimiter({ sweepIntervalMs: 20 })
      // Backdated relative to *real* Date.now() so the next automatic sweep
      // (which calls sweep(Date.now())) finds it already expired.
      rateLimiter.tryAcquireIp('5.5.5.5', Date.now() - 16 * 60 * 1000)
      expect(rateLimiter.ipBucketSizeForTesting()).toBe(1)

      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(rateLimiter.ipBucketSizeForTesting()).toBe(0)
    })
  })

  describe('per-bucket key cap', () => {
    it('evicts the least-recently-touched key once a bucket would exceed the cap', () => {
      const rateLimiter = newLimiter({ maxKeysPerBucket: 3 })
      rateLimiter.tryAcquireIp('1.1.1.1', 0)
      rateLimiter.tryAcquireIp('1.1.1.2', 1)
      rateLimiter.tryAcquireIp('1.1.1.3', 2)
      expect(rateLimiter.ipBucketSizeForTesting()).toBe(3)

      // A 4th distinct key pushes the bucket over the cap — 1.1.1.1 (the
      // least-recently-touched) is evicted, keeping the size at the cap.
      rateLimiter.tryAcquireIp('1.1.1.4', 3)
      expect(rateLimiter.ipBucketSizeForTesting()).toBe(3)
    })

    it('touching an existing key counts as "recently used" and protects it from eviction', () => {
      const rateLimiter = newLimiter({ maxKeysPerBucket: 3 })
      // Push 1.1.1.2 to one below its own 20-attempt limit — a clean slate
      // vs. a surviving near-full bucket is what makes eviction observable
      // below, since bucket *size* alone can't say which key was evicted.
      for (let i = 0; i < 19; i++) rateLimiter.tryAcquireIp('1.1.1.2', i)
      rateLimiter.tryAcquireIp('1.1.1.1', 100)
      rateLimiter.tryAcquireIp('1.1.1.3', 101)
      // Re-touch 1.1.1.1 and 1.1.1.3 — 1.1.1.2 is now the least-recently-used.
      rateLimiter.tryAcquireIp('1.1.1.1', 102)
      rateLimiter.tryAcquireIp('1.1.1.3', 103)

      // Over capacity — evicts 1.1.1.2, not 1.1.1.1 or 1.1.1.3.
      rateLimiter.tryAcquireIp('1.1.1.4', 104)
      expect(rateLimiter.ipBucketSizeForTesting()).toBe(3)

      // Had 1.1.1.2 survived, it would already sit at 19 reservations and
      // this next one would trip it. Eviction means a clean slate instead.
      expect(rateLimiter.tryAcquireIp('1.1.1.2', 105).allowed).toBe(true)
    })
  })
})
