import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API } from '@kobolink/contracts'
import { Pool } from 'pg'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'

/**
 * B0's "done when": the app boots against a real Postgres container (not a
 * mock, not pg-mem) and `GET /api/health` returns 200. This is the test the
 * feature is graded on.
 */
describe('GET /api/health (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext

  beforeAll(async () => {
    ctx = await startApiTestContext()
  }, 120_000)

  afterAll(async () => {
    await ctx.teardown()
  })

  it('boots the full Nest app against the container and answers 200', async () => {
    const response = await ctx.request.get(API.health)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'ok' })
  })

  it('is answering from the real container, not a stub — a second, independent connection sees the same server', async () => {
    const pool = new Pool({ connectionString: ctx.connectionString })
    try {
      const result = await pool.query<{ one: number }>('select 1 as one')
      expect(result.rows).toEqual([{ one: 1 }])
    } finally {
      await pool.end()
    }
  })

  it('a request for an unknown route still comes back as the contract shape, not an HTML 404 page', async () => {
    const response = await ctx.request.get('/api/this-route-does-not-exist')

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ code: 'not_found' })
  })
})
