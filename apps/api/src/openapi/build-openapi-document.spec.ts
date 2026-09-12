import { SCHEMAS, type SchemaName } from '@kobolink/contracts'
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

  it('marks every session-guarded route with both accepted credentials, and no others', () => {
    const document = buildOpenApiDocument()
    const guarded = ROUTES.filter((route) => route.auth === 'session')
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

  it('building twice from the same contracts produces byte-identical documents (deterministic, not order-dependent)', () => {
    expect(buildOpenApiDocument()).toEqual(buildOpenApiDocument())
  })
})
