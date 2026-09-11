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
  let ctx: ApiTestContext | undefined

  beforeAll(async () => {
    ctx = await startApiTestContext()
  }, 120_000)

  afterAll(async () => {
    // beforeAll can fail before assigning ctx (a bad container start, a
    // migration error); afterAll still runs, and must not throw a second,
    // more confusing error on top of whatever beforeAll already reported.
    await ctx?.teardown()
  })

  it('boots the full Nest app against the container and answers 200', async () => {
    const response = await getCtx().request.get(API.health)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'ok' })
  })

  it('is answering from the real container, not a stub — the health check leaves the app\'s own connection behind in pg_stat_activity', async () => {
    const response = await getCtx().request.get(API.health)
    expect(response.status).toBe(200)

    // A connection distinct from this probe's own backend proves it is the
    // *app's* pool that reached this container, not a mock or a different
    // database entirely.
    const probe = new Pool({ connectionString: getCtx().connectionString })
    try {
      const result = await probe.query<{ count: number }>(
        `select count(*)::int as count from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`,
      )
      expect(result.rows[0]?.count ?? 0).toBeGreaterThan(0)
    } finally {
      await probe.end()
    }
  })

  it('a request for an unknown route still comes back as the contract shape, not an HTML 404 page', async () => {
    const response = await getCtx().request.get('/api/this-route-does-not-exist')

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ code: 'not_found' })
  })

  it.each(['/api', '/api/'])(
    'the bare prefix %s also comes back as the contract shape, not Express\'s default 404 page',
    async (target) => {
      const response = await getCtx().request.get(target)

      expect(response.status).toBe(404)
      expect(response.body).toMatchObject({ code: 'not_found' })
    },
  )

  it('a real path with the wrong method also comes back as the contract shape', async () => {
    const response = await getCtx().request.delete(API.health)

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ code: 'not_found' })
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
