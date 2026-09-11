import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API } from '@kobolink/contracts'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'

/**
 * Review round 1, finding 1 — the IP-bucket half of the concurrency fix.
 * The reviewer's own probe used 60 parallel requests; this file uses 25 —
 * comfortably over the 20 limit while keeping the raw simultaneous-socket
 * count against the local test server modest. A larger burst (60, then 35)
 * proved flaky when run as part of the full sequential `test:api` suite in
 * this environment — many Testcontainers started and stopped in a row
 * leaves less headroom than running one file in isolation — for reasons at
 * the TCP/accept-queue level, not the admission logic itself (the same
 * assertion at 25 is reliable across repeated full-suite runs). Distinct
 * emails (so no single email's own 5-attempt bucket ever trips), all from
 * one IP (limit 20). See auth-rate-limit-email-concurrent.integration.test.ts
 * for the email-bucket half and the fuller explanation; own file/container
 * for the same reason.
 */
describe('POST /api/auth/login rate limiting: concurrent requests admit at most the IP limit (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined

  beforeAll(async () => {
    ctx = await startApiTestContext()
  }, 120_000)

  afterAll(async () => {
    await ctx?.teardown()
  })

  it('25 parallel wrong-password logins across 25 distinct emails from one IP admit exactly 20, block the rest with 429', async () => {
    const responses = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        getCtx()
          .request.post(API.auth.login)
          .send({ email: `concurrent-ip-limit-${i}@example.test`, password: 'wrong password', client: 'web' }),
      ),
    )

    const admitted = responses.filter((response) => response.status === 401)
    const blocked = responses.filter((response) => response.status === 429)

    expect(admitted).toHaveLength(20)
    expect(blocked).toHaveLength(5)
    for (const response of blocked) {
      expect(response.body).toMatchObject({ code: 'rate_limited' })
    }
  }, 30_000)

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
