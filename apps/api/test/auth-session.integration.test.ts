import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API, ApiErrorSchema, AuthResponseSchema, MeResponseSchema } from '@kobolink/contracts'
import { Pool } from 'pg'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'

/**
 * B2's `POST /api/auth/logout` and `GET /api/auth/me` — PLAN.md's B2 row.
 * Covers the guard's done-when set beyond wrong-password/unknown-user
 * (those live in auth-login.integration.test.ts): an expired session, a
 * revoked (logged-out) session, and both credential shapes — the web cookie
 * and the mobile bearer token — landing on the identical guard.
 */
describe('auth session guard: POST /api/auth/logout, GET /api/auth/me (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined
  let pool: Pool | undefined

  beforeAll(async () => {
    ctx = await startApiTestContext()
    pool = new Pool({ connectionString: getCtx().connectionString })
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    await ctx?.teardown()
  })

  function sessionCookieFrom(response: { headers: Record<string, string | string[] | undefined> }): string {
    const setCookie = response.headers['set-cookie']
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie !== undefined ? [setCookie] : []
    const match = cookies.map((c) => c.split(';')[0]).find((c) => c?.startsWith('kobolink_session='))
    if (match === undefined) throw new Error('no kobolink_session cookie in response headers')
    return match
  }

  async function registerWeb(email: string): Promise<{ cookie: string; sessionId: string }> {
    const response = await getCtx().request.post(API.auth.register).send({
      email,
      password: 'correct horse battery staple',
      displayName: 'Session Fixture',
      client: 'web',
    })
    if (response.status !== 201) throw new Error(`fixture register failed: ${response.status} ${JSON.stringify(response.body)}`)
    const body = AuthResponseSchema.parse(response.body)
    return { cookie: sessionCookieFrom(response), sessionId: body.session.id }
  }

  async function registerMobile(email: string): Promise<{ token: string; sessionId: string }> {
    const response = await getCtx().request.post(API.auth.register).send({
      email,
      password: 'correct horse battery staple',
      displayName: 'Session Fixture',
      client: 'mobile',
    })
    if (response.status !== 201) throw new Error(`fixture register failed: ${response.status} ${JSON.stringify(response.body)}`)
    const body = AuthResponseSchema.parse(response.body)
    if (body.token === undefined) throw new Error('mobile register returned no token')
    return { token: body.token, sessionId: body.session.id }
  }

  it('me: 401 with no credential at all', async () => {
    const response = await getCtx().request.get(API.auth.me)
    expect(response.status).toBe(401)
    expect(ApiErrorSchema.parse(response.body).code).toBe('unauthenticated')
  })

  it('me: 200 and the registered user, via the web cookie', async () => {
    const { cookie } = await registerWeb('me-cookie@example.test')

    const response = await getCtx().request.get(API.auth.me).set('Cookie', cookie)

    expect(response.status).toBe(200)
    const body = MeResponseSchema.parse(response.body)
    expect(body.user.email).toBe('me-cookie@example.test')
  })

  it('me: 200 and the registered user, via the mobile bearer token', async () => {
    const { token } = await registerMobile('me-bearer@example.test')

    const response = await getCtx().request.get(API.auth.me).set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    expect(MeResponseSchema.parse(response.body).user.email).toBe('me-bearer@example.test')
  })

  it('me: 401 for an unrecognised bearer token', async () => {
    const response = await getCtx().request.get(API.auth.me).set('Authorization', 'Bearer not-a-real-token-at-all')
    expect(response.status).toBe(401)
    expect(ApiErrorSchema.parse(response.body).code).toBe('unauthenticated')
  })

  it('logout: 401 with no credential', async () => {
    const response = await getCtx().request.post(API.auth.logout)
    expect(response.status).toBe(401)
  })

  it('logout then me: 204 with a cleared cookie, then 401 — the session is revoked server-side, not merely forgotten client-side', async () => {
    const { cookie } = await registerWeb('logout-flow@example.test')

    const logoutResponse = await getCtx().request.post(API.auth.logout).set('Cookie', cookie)
    expect(logoutResponse.status).toBe(204)

    const clearCookie = sessionCookieFrom(logoutResponse)
    // Express's clearCookie sets an empty value and an Expires in the past.
    expect(clearCookie).toBe('kobolink_session=')
    const rawClearCookieHeader = logoutResponse.headers['set-cookie'] as string | string[] | undefined
    const clearCookieHeader = Array.isArray(rawClearCookieHeader) ? rawClearCookieHeader[0] : rawClearCookieHeader
    expect(clearCookieHeader).toMatch(/Expires=/)

    // Replaying the *original* cookie value (a client that ignored the
    // clear instruction, or captured the token before logout) must still
    // fail — proving the session row itself was revoked, not just the
    // client-side cookie cleared.
    const meAfterLogout = await getCtx().request.get(API.auth.me).set('Cookie', cookie)
    expect(meAfterLogout.status).toBe(401)
    expect(ApiErrorSchema.parse(meAfterLogout.body).code).toBe('unauthenticated')
  })

  it('logout is idempotent: a second logout with the same (now-revoked) cookie still fails cleanly with 401, not a 500', async () => {
    const { cookie } = await registerWeb('double-logout@example.test')

    const first = await getCtx().request.post(API.auth.logout).set('Cookie', cookie)
    expect(first.status).toBe(204)

    const second = await getCtx().request.post(API.auth.logout).set('Cookie', cookie)
    expect(second.status).toBe(401)
  })

  it('an expired session is rejected on GET /api/auth/me even though the token itself is still correct', async () => {
    const { cookie, sessionId } = await registerWeb('expired-session@example.test')

    await getPool().query(`update sessions set expires_at = now() - interval '1 day' where id = $1`, [sessionId])

    const response = await getCtx().request.get(API.auth.me).set('Cookie', cookie)
    expect(response.status).toBe(401)
    expect(ApiErrorSchema.parse(response.body).code).toBe('unauthenticated')
  })

  it('a mobile bearer token also fails once its session is revoked', async () => {
    const { token } = await registerMobile('mobile-logout@example.test')

    const logoutResponse = await getCtx().request.post(API.auth.logout).set('Authorization', `Bearer ${token}`)
    expect(logoutResponse.status).toBe(204)

    const meResponse = await getCtx().request.get(API.auth.me).set('Authorization', `Bearer ${token}`)
    expect(meResponse.status).toBe(401)
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }

  function getPool(): Pool {
    if (pool === undefined) throw new Error('beforeAll did not produce a pool — see its own failure above')
    return pool
  }
})
