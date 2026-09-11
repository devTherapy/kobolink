import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API, ApiErrorSchema, AuthResponseSchema } from '@kobolink/contracts'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from '../src/db/schema/index.js'
import { SEED_MERCHANT_EMAIL, seed } from '../src/db/seed.js'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'

const SEED_TEST_PASSWORD = 'a-perfectly-good-seed-password'

/**
 * B2's `POST /api/auth/login` — PLAN.md's B2 row, DESIGN-SPEC.md §5. The
 * headline invariant this file exists to prove: an unknown email and a
 * wrong password for a real account are *indistinguishable* on the wire —
 * same status, same body, byte for byte.
 */
describe('POST /api/auth/login (real Postgres via Testcontainers)', () => {
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

  async function register(email: string, password: string): Promise<void> {
    const response = await getCtx().request.post(API.auth.register).send({
      email,
      password,
      displayName: 'Login Fixture',
      client: 'web',
    })
    if (response.status !== 201) throw new Error(`fixture register failed: ${response.status} ${JSON.stringify(response.body)}`)
  }

  it('web: correct credentials return 200, a session cookie, and no token', async () => {
    await register('login-web@example.test', 'correct horse battery staple')

    const response = await getCtx().request.post(API.auth.login).send({
      email: 'login-web@example.test',
      password: 'correct horse battery staple',
      client: 'web',
    })

    expect(response.status).toBe(200)
    const body = AuthResponseSchema.parse(response.body)
    expect(body.token).toBeUndefined()
    expect(body.user.email).toBe('login-web@example.test')
    expect(response.headers['set-cookie']).toBeDefined()
  })

  it('mobile: correct credentials return 200 and a bearer token, no cookie', async () => {
    await register('login-mobile@example.test', 'correct horse battery staple')

    const response = await getCtx().request.post(API.auth.login).send({
      email: 'login-mobile@example.test',
      password: 'correct horse battery staple',
      client: 'mobile',
    })

    expect(response.status).toBe(200)
    const body = AuthResponseSchema.parse(response.body)
    expect(body.token).toBeDefined()
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('wrong password and an unknown email produce the identical 401 body', async () => {
    await register('known-user@example.test', 'correct horse battery staple')

    const wrongPassword = await getCtx().request.post(API.auth.login).send({
      email: 'known-user@example.test',
      password: 'definitely the wrong password',
      client: 'web',
    })
    const unknownUser = await getCtx().request.post(API.auth.login).send({
      email: 'no-such-user@example.test',
      password: 'anything at all here',
      client: 'web',
    })

    expect(wrongPassword.status).toBe(401)
    expect(unknownUser.status).toBe(401)
    const wrongPasswordBody = ApiErrorSchema.parse(wrongPassword.body)
    const unknownUserBody = ApiErrorSchema.parse(unknownUser.body)
    expect(wrongPasswordBody.code).toBe('unauthenticated')
    expect(wrongPasswordBody).toEqual(unknownUserBody)
    // Neither response sets a session cookie.
    expect(wrongPassword.headers['set-cookie']).toBeUndefined()
    expect(unknownUser.headers['set-cookie']).toBeUndefined()
  })

  it('validation failure: a missing password is rejected before touching the database', async () => {
    const response = await getCtx().request.post(API.auth.login).send({
      email: 'missing-password@example.test',
      client: 'web',
    })

    expect(response.status).toBe(400)
    const body = ApiErrorSchema.parse(response.body)
    expect(body.code).toBe('validation_failed')
    expect(body.fields).toHaveProperty('password')
  })

  it('the seeded merchant (seed run with SEED_MERCHANT_PASSWORD) can log in through the real endpoint', async () => {
    const db = drizzle(getPool(), { schema })
    const result = await seed(db, SEED_TEST_PASSWORD)
    expect(result.skippedMerchant).toBe(false)

    const response = await getCtx().request.post(API.auth.login).send({
      email: SEED_MERCHANT_EMAIL,
      password: SEED_TEST_PASSWORD,
      client: 'web',
    })

    expect(response.status).toBe(200)
    const body = AuthResponseSchema.parse(response.body)
    expect(body.user.email).toBe(SEED_MERCHANT_EMAIL)
    expect(body.user.role).toBe('merchant')
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
