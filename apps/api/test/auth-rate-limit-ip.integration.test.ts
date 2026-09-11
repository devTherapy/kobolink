import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API, ApiErrorSchema } from '@kobolink/contracts'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'

/**
 * B2's login rate limit, per-IP bucket — PLAN.md's B2 row, DESIGN-SPEC.md
 * §5 ("credential stuffing"). One IP failing logins against 20 *different*
 * emails (none of which individually reaches the 5-per-email limit) must
 * still trip after the 20th failure — the pattern the IP bucket exists to
 * catch. Its own file/container, same reasoning as the email-bucket file:
 * every request here shares one loopback address, so this suite's own
 * attempt count is what trips it, deliberately.
 */
describe('POST /api/auth/login rate limiting: per-IP bucket (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined

  beforeAll(async () => {
    ctx = await startApiTestContext()
  }, 120_000)

  afterAll(async () => {
    await ctx?.teardown()
  })

  it('trips after 20 failed attempts across distinct emails from the same IP', async () => {
    for (let i = 0; i < 20; i++) {
      const response = await getCtx()
        .request.post(API.auth.login)
        .send({ email: `ip-bucket-${i}@example.test`, password: 'wrong password', client: 'web' })
      expect(response.status).toBe(401)
    }

    // A 21st attempt, against yet another fresh email whose own per-email
    // bucket is empty, is still blocked — only the shared IP bucket
    // explains it.
    const tripped = await getCtx()
      .request.post(API.auth.login)
      .send({ email: 'ip-bucket-fresh@example.test', password: 'wrong password', client: 'web' })

    expect(tripped.status).toBe(429)
    expect(ApiErrorSchema.parse(tripped.body).code).toBe('rate_limited')
    expect(Number(tripped.headers['retry-after'])).toBeGreaterThan(0)
  }, 30_000)

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
