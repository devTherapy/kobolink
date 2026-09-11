import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API, ApiErrorSchema } from '@kobolink/contracts'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'

/**
 * B2's login rate limit, email bucket — PLAN.md's B2 row, DESIGN-SPEC.md
 * §5. `RateLimiterService`'s own unit tests cover the window arithmetic in
 * isolation; this file proves the same behaviour end to end through the
 * real HTTP endpoint, including the `Retry-After` header and that a
 * *correct* password stops working once the bucket is tripped.
 *
 * Own file, own container: every request in this suite reaches the app
 * from the same loopback address, so the 20-per-IP bucket would otherwise
 * accumulate across this file and auth-rate-limit-ip.integration.test.ts —
 * this file stays well under 20 total login attempts so it only ever
 * exercises the 5-per-email bucket.
 */
describe('POST /api/auth/login rate limiting: per-email bucket (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined

  beforeAll(async () => {
    ctx = await startApiTestContext()
  }, 120_000)

  afterAll(async () => {
    await ctx?.teardown()
  })

  it('trips after 5 failures and rejects the correct password too, with a Retry-After header', async () => {
    const email = 'rate-limit-trip@example.test'
    const password = 'correct horse battery staple'

    const register = await getCtx().request.post(API.auth.register).send({
      email,
      password,
      displayName: 'Rate Limit Fixture',
      client: 'web',
    })
    expect(register.status).toBe(201)

    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await getCtx().request.post(API.auth.login).send({ email, password: 'wrong password', client: 'web' })
      expect(response.status).toBe(401)
    }

    // The 6th attempt, with the *correct* password, is still rejected.
    const tripped = await getCtx().request.post(API.auth.login).send({ email, password, client: 'web' })

    expect(tripped.status).toBe(429)
    expect(ApiErrorSchema.parse(tripped.body).code).toBe('rate_limited')
    const retryAfter = Number(tripped.headers['retry-after'])
    expect(Number.isFinite(retryAfter)).toBe(true)
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(15 * 60)
    // A tripped bucket does not set a session cookie.
    expect(tripped.headers['set-cookie']).toBeUndefined()
  })

  it('a successful login resets the email bucket, so failures before it do not carry over', async () => {
    const email = 'rate-limit-reset@example.test'
    const password = 'correct horse battery staple'

    const register = await getCtx().request.post(API.auth.register).send({
      email,
      password,
      displayName: 'Rate Limit Reset Fixture',
      client: 'web',
    })
    expect(register.status).toBe(201)

    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await getCtx().request.post(API.auth.login).send({ email, password: 'wrong password', client: 'web' })
      expect(response.status).toBe(401)
    }

    const success = await getCtx().request.post(API.auth.login).send({ email, password, client: 'web' })
    expect(success.status).toBe(200)

    // Without the reset, these 5 would already be sitting on the 4 prior
    // failures and the 5th of these would trip the bucket (429 instead of
    // 401). With the reset, all 5 land as plain wrong-password rejections.
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await getCtx().request.post(API.auth.login).send({ email, password: 'wrong password again', client: 'web' })
      expect(response.status).toBe(401)
    }
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
