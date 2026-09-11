import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API, ApiErrorSchema, AuthResponseSchema } from '@kobolink/contracts'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'

/**
 * B2's `POST /api/auth/register` — PLAN.md's B2 row, DESIGN-SPEC.md §5.
 * Happy path (web + mobile), validation failure, and the conflict case that
 * must not reveal *which* field (email or phone) collided.
 */
describe('POST /api/auth/register (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined

  beforeAll(async () => {
    ctx = await startApiTestContext()
  }, 120_000)

  afterAll(async () => {
    await ctx?.teardown()
  })

  it('web: 201, a parsed AuthResponse with no token, and an httpOnly/Secure/SameSite=Lax/Path=/ session cookie', async () => {
    const response = await getCtx()
      .request.post(API.auth.register)
      .send({
        email: 'ada@example.test',
        password: 'correct horse battery staple',
        displayName: 'Ada Lovelace',
        role: 'merchant',
        client: 'web',
      })

    expect(response.status).toBe(201)
    const body = AuthResponseSchema.parse(response.body)
    expect(body.token).toBeUndefined()
    expect(body.user.email).toBe('ada@example.test')
    expect(body.user.role).toBe('merchant')

    const setCookie = asCookieArray(response.headers['set-cookie'])
    const sessionCookie = setCookie.find((c) => c.startsWith('kobolink_session='))
    expect(sessionCookie).toBeDefined()
    expect(sessionCookie).toContain('HttpOnly')
    expect(sessionCookie).toContain('SameSite=Lax')
    expect(sessionCookie).toContain('Path=/')
    // NODE_ENV under vitest is "test", not "development" — Secure must be set.
    expect(sessionCookie).toContain('Secure')
  })

  it('mobile: 201, a token of at least 32 characters, and no Set-Cookie header at all', async () => {
    const response = await getCtx()
      .request.post(API.auth.register)
      .send({
        email: 'grace@example.test',
        password: 'correct horse battery staple',
        displayName: 'Grace Hopper',
        client: 'mobile',
      })

    expect(response.status).toBe(201)
    const body = AuthResponseSchema.parse(response.body)
    expect(body.token).toBeDefined()
    expect(body.token?.length).toBeGreaterThanOrEqual(32)
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('defaults role to merchant and client to web when omitted', async () => {
    const response = await getCtx().request.post(API.auth.register).send({
      email: 'default-role@example.test',
      password: 'correct horse battery staple',
      displayName: 'Default Role',
    })

    expect(response.status).toBe(201)
    const body = AuthResponseSchema.parse(response.body)
    expect(body.user.role).toBe('merchant')
    expect(body.token).toBeUndefined()
  })

  it('validation failure: a too-short password is rejected with validation_failed and a field-keyed message', async () => {
    const response = await getCtx().request.post(API.auth.register).send({
      email: 'short-password@example.test',
      password: 'short',
      displayName: 'Too Short',
      client: 'web',
    })

    expect(response.status).toBe(400)
    const body = ApiErrorSchema.parse(response.body)
    expect(body.code).toBe('validation_failed')
    expect(body.fields).toHaveProperty('password')
  })

  it('validation failure: a malformed email is rejected', async () => {
    const response = await getCtx().request.post(API.auth.register).send({
      email: 'not-an-email',
      password: 'correct horse battery staple',
      displayName: 'Bad Email',
      client: 'web',
    })

    expect(response.status).toBe(400)
    const body = ApiErrorSchema.parse(response.body)
    expect(body.code).toBe('validation_failed')
    expect(body.fields).toHaveProperty('email')
  })

  it('conflict: a taken email is rejected with the same generic message as a taken phone, revealing neither', async () => {
    const first = await getCtx().request.post(API.auth.register).send({
      email: 'duplicate@example.test',
      phone: '+2348031111111',
      password: 'correct horse battery staple',
      displayName: 'First',
      client: 'web',
    })
    expect(first.status).toBe(201)

    const sameEmail = await getCtx().request.post(API.auth.register).send({
      email: 'duplicate@example.test',
      password: 'correct horse battery staple',
      displayName: 'Second',
      client: 'web',
    })
    const samePhone = await getCtx().request.post(API.auth.register).send({
      email: 'different@example.test',
      phone: '+2348031111111',
      password: 'correct horse battery staple',
      displayName: 'Third',
      client: 'web',
    })

    expect(sameEmail.status).toBe(409)
    expect(samePhone.status).toBe(409)
    const sameEmailBody = ApiErrorSchema.parse(sameEmail.body)
    const samePhoneBody = ApiErrorSchema.parse(samePhone.body)
    expect(sameEmailBody.code).toBe('conflict')
    expect(samePhoneBody.code).toBe('conflict')
    // Identical body either way — a caller cannot tell which field collided.
    expect(sameEmailBody).toEqual(samePhoneBody)
  })

  function asCookieArray(setCookie: string | string[] | undefined): string[] {
    if (setCookie === undefined) return []
    return Array.isArray(setCookie) ? setCookie : [setCookie]
  }

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
