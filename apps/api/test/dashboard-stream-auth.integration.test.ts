import { API, ApiErrorSchema } from '@kobolink/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerCustomer } from './support/register-user.js'

/**
 * `GET /api/stream/dashboard` — PLAN.md's B6 row. Same guard composition as
 * `LinksController` (`@UseGuards(SessionGuard, MerchantGuard)`), and this
 * suite proves it the same way `merchant-guard.integration.test.ts` proves
 * it for a throwaway route: for real, over HTTP, against the actual
 * `DashboardModule` wiring. Both failures happen before the handler ever
 * calls `res.flushHeaders()`, so they come back as an ordinary JSON
 * `ApiError`, not a half-open stream.
 */
describe('GET /api/stream/dashboard — authentication and authorisation (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined

  beforeAll(async () => {
    ctx = await startApiTestContext()
  }, 120_000)

  afterAll(async () => {
    await ctx?.teardown()
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }

  it('401s a request with no session credential at all', async () => {
    const response = await getCtx().request.get(API.dashboard.stream)
    expect(response.status).toBe(401)
    expect(ApiErrorSchema.parse(response.body).code).toBe('unauthenticated')
  })

  it('401s a request with a garbage session cookie', async () => {
    const response = await getCtx().request.get(API.dashboard.stream).set('Cookie', 'kobolink_session=not-a-real-token')
    expect(response.status).toBe(401)
    expect(ApiErrorSchema.parse(response.body).code).toBe('unauthenticated')
  })

  it('403s an authenticated customer — a real user, just not a merchant', async () => {
    const customer = await registerCustomer(getCtx(), 'sse-auth-customer@example.test')
    const response = await getCtx().request.get(API.dashboard.stream).set('Cookie', customer.cookie)
    expect(response.status).toBe(403)
    expect(ApiErrorSchema.parse(response.body).code).toBe('forbidden')
  })

  // A merchant successfully opening the stream (200, `text/event-stream`,
  // and beyond) is proven by every test in dashboard-stream-events.
  // integration.test.ts and its siblings — supertest buffers a whole
  // response body before resolving, which an SSE stream that stays open
  // indefinitely never provides, so this file (which only needs a status
  // code and a JSON body) sticks to the two rejection paths above and
  // leaves "reachable" to the tests that actually read the stream.
})
