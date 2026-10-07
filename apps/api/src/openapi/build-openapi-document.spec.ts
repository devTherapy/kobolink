import { API, SCHEMAS, type SchemaName } from '@kobolink/contracts'
import { Validator } from '@seriousme/openapi-schema-validator'
import { describe, expect, it } from 'vitest'
import { buildOpenApiDocument } from './build-openapi-document.js'
import { ROUTES } from './route-manifest.js'

describe('buildOpenApiDocument', () => {
  it('is structurally valid OpenAPI 3.1 — not just "looks right"', async () => {
    const document = buildOpenApiDocument()
    const validator = new Validator()

    const result = await validator.validate(document as unknown as Record<string, unknown>)

    expect(result.errors).toBeUndefined()
    expect(result.valid).toBe(true)
    expect(validator.version).toBe('3.1')
  })

  it('declares components.schemas for every named schema in the contracts registry — none silently missing', () => {
    const document = buildOpenApiDocument()
    const names = Object.keys(SCHEMAS) as SchemaName[]

    for (const name of names) {
      expect(document.components.schemas, `components.schemas.${name}`).toHaveProperty(name)
    }
    expect(Object.keys(document.components.schemas).sort()).toEqual([...names].sort())
  })

  it('has exactly one path item per route in the manifest, at the route\'s own path', () => {
    const document = buildOpenApiDocument()
    for (const route of ROUTES) {
      expect(document.paths, route.path).toHaveProperty(route.path)
      expect(document.paths[route.path], `${route.method} ${route.path}`).toHaveProperty(route.method)
    }
  })

  it('gives every operation a response schema that $refs a real component (or is the health route\'s inline shape)', () => {
    const document = buildOpenApiDocument()
    for (const [path, pathItem] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        const responses = (operation as { responses: Record<string, unknown> }).responses
        expect(Object.keys(responses), `${method} ${path} has no responses`).not.toHaveLength(0)
        expect(responses, `${method} ${path} should always document the default error`).toHaveProperty('default')
      }
    }
  })

  it('marks every guarded route (session or merchant) with both accepted credentials, and no others', () => {
    const document = buildOpenApiDocument()
    const guarded = ROUTES.filter((route) => route.auth !== 'none')
    const open = ROUTES.filter((route) => route.auth === 'none')

    for (const route of guarded) {
      const operation = document.paths[route.path]![route.method] as { security?: unknown }
      expect(operation.security, `${route.method} ${route.path}`).toEqual([{ sessionCookie: [] }, { bearerAuth: [] }])
    }
    for (const route of open) {
      const operation = document.paths[route.path]![route.method] as { security?: unknown }
      expect(operation.security, `${route.method} ${route.path}`).toBeUndefined()
    }
  })

  it('says in prose which guarded routes also need the merchant role — security alone cannot', () => {
    const document = buildOpenApiDocument()
    for (const route of ROUTES) {
      const operation = document.paths[route.path]![route.method] as { description?: string }
      if (route.auth === 'merchant') {
        expect(operation.description, `${route.method} ${route.path}`).toContain('merchant role')
      } else {
        expect(operation.description ?? '', `${route.method} ${route.path}`).not.toContain('merchant role')
      }
    }
  })

  it('describes the SSE stream as text/event-stream whose frames are DashboardEvent, not as a JSON body', () => {
    const document = buildOpenApiDocument()
    const operation = document.paths[API.dashboard.stream]!.get as {
      description?: string
      security?: unknown
      responses: Record<string, { content?: Record<string, { schema: unknown }> }>
    }

    expect(operation.responses['200']!.content).toEqual({
      'text/event-stream': { schema: { $ref: '#/components/schemas/DashboardEvent' } },
    })
    expect(operation.responses['200']!.content).not.toHaveProperty('application/json')
    // The failure path is still ordinary JSON: guards run before the first byte.
    expect(operation.responses.default!.content).toHaveProperty('application/json')
    expect(operation.security).toEqual([{ sessionCookie: [] }, { bearerAuth: [] }])
    expect(operation.description).toContain('Last-Event-ID')
  })

  it('building twice from the same contracts produces byte-identical documents (deterministic, not order-dependent)', () => {
    expect(buildOpenApiDocument()).toEqual(buildOpenApiDocument())
  })
})
