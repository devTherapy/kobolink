import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API } from '@kobolink/contracts'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'

/**
 * Review round 1, finding 1: the rate limiter was check-then-act —
 * `check()` ran, the request then awaited a DB select and an argon2 verify
 * (~15ms), and only *then* did `recordFailure()` run. A burst of genuinely
 * concurrent requests all saw the same pre-request bucket state and were
 * admitted together, regardless of the limit. The reviewer's own probe: 30
 * parallel wrong-password logins for one email (limit 5) previously
 * produced 28x401/2x429 instead of the correct 5x401/25x429. This file uses
 * 12 instead of 30 — see auth-rate-limit-ip-concurrent.integration.test.ts's
 * doc comment for why a smaller, still-comfortably-over-the-limit burst is
 * more reliable across a full sequential `test:api` run in this
 * environment.
 *
 * `tryAcquireLogin` now reserves synchronously, before any `await` — this
 * file proves that holds under real concurrent HTTP load, not just
 * sequential calls (`rate-limiter.service.spec.ts` already covers the pure
 * logic; `auth-rate-limit-email.integration.test.ts` already covers the
 * sequential HTTP case). Own file/container: `Promise.all` here saturates
 * this file's IP bucket too (every request shares one loopback address),
 * so it must not share a container with any other rate-limit assertions.
 */
describe('POST /api/auth/login rate limiting: concurrent requests admit at most the email limit (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined

  beforeAll(async () => {
    ctx = await startApiTestContext()
  }, 120_000)

  afterAll(async () => {
    await ctx?.teardown()
  })

  it('12 parallel wrong-password logins for one email admit exactly 5, block the rest with 429', async () => {
    const email = 'concurrent-email-limit@example.test'

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        getCtx().request.post(API.auth.login).send({ email, password: 'wrong password', client: 'web' }),
      ),
    )

    const admitted = responses.filter((response) => response.status === 401)
    const blocked = responses.filter((response) => response.status === 429)

    expect(admitted).toHaveLength(5)
    expect(blocked).toHaveLength(7)
    expect(responses).toHaveLength(admitted.length + blocked.length)
    for (const response of blocked) {
      expect(response.body).toMatchObject({ code: 'rate_limited' })
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0)
    }
  }, 30_000)

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
