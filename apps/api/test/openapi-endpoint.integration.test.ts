import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Validator } from '@seriousme/openapi-schema-validator'
import { buildOpenApiDocument } from '../src/openapi/build-openapi-document.js'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'

/**
 * B7's runtime half: `GET /api/openapi.json` is served by the same full Nest
 * app every other route runs through — `OpenApiModule` sits in `AppModule`
 * alongside `DbModule` et al., so exercising it for real means booting the
 * whole app, hence Testcontainers rather than a unit test. The generation
 * logic itself (validity, contracts coverage, drift) is unit-tested in
 * `src/openapi/*.spec.ts`, which need no database at all; this file only
 * proves the HTTP route actually serves that same document.
 */
describe('GET /api/openapi.json (real Nest app via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined

  beforeAll(async () => {
    ctx = await startApiTestContext()
  }, 120_000)

  afterAll(async () => {
    await ctx?.teardown()
  })

  it('serves a 200 with the same document buildOpenApiDocument() produces', async () => {
    const response = await getCtx().request.get('/api/openapi.json')

    expect(response.status).toBe(200)
    expect(response.body).toEqual(buildOpenApiDocument())
  })

  it('serves a structurally valid OpenAPI 3.1 document over the wire, not just in-process', async () => {
    const response = await getCtx().request.get('/api/openapi.json')
    const validator = new Validator()

    const result = await validator.validate(response.body as Record<string, unknown>)

    expect(result.errors).toBeUndefined()
    expect(result.valid).toBe(true)
  })

  it('needs no credential — M0\'s model generators and a curious human both call it unauthenticated', async () => {
    const response = await getCtx().request.get('/api/openapi.json')
    expect(response.status).not.toBe(401)
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
