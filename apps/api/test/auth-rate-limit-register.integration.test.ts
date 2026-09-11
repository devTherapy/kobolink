import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API } from '@kobolink/contracts'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'

/**
 * Review round 1, finding 3: registration was unthrottled — nothing stopped
 * one IP from registering an unbounded number of accounts. `AuthService.register`
 * now calls `RateLimiterService.tryAcquireIp`, sharing the exact bucket
 * `tryAcquireLogin` uses for login's own IP limit (20/15min). Own
 * file/container so this test's own parallel registrations are the only
 * thing contributing to that shared bucket. 25, not the reviewer's own
 * 30-request probe — see auth-rate-limit-ip-concurrent.integration.test.ts's
 * doc comment for why a smaller, still-comfortably-over-the-limit burst is
 * more reliable across a full sequential `test:api` run in this
 * environment (registration is also the heaviest of these three requests —
 * every admitted one pays a real argon2 hash plus an insert, not just a
 * dummy-hash verify).
 */
describe('POST /api/auth/register rate limiting: per-IP bucket (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined

  beforeAll(async () => {
    ctx = await startApiTestContext()
  }, 120_000)

  afterAll(async () => {
    await ctx?.teardown()
  })

  it('25 parallel registrations from one IP admit at most 20, block the rest with 429', async () => {
    const responses = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        getCtx()
          .request.post(API.auth.register)
          .send({
            email: `concurrent-register-${i}@example.test`,
            password: 'correct horse battery staple',
            displayName: `Concurrent Register ${i}`,
            client: 'web',
          }),
      ),
    )

    const admitted = responses.filter((response) => response.status === 201)
    const blocked = responses.filter((response) => response.status === 429)

    expect(admitted.length).toBeLessThanOrEqual(20)
    expect(admitted).toHaveLength(20)
    expect(blocked).toHaveLength(5)
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
