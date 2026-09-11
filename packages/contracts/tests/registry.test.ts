import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  DashboardEventSchema,
  SCHEMAS,
  exampleLink,
  examplePayment,
  exampleStats,
  exampleUser,
  exampleWallet,
  jsonSchemas,
} from '../src/index.js'

describe('SCHEMAS registry', () => {
  it('names every schema by its own metadata id — the OpenAPI component name', () => {
    for (const [name, schema] of Object.entries(SCHEMAS)) {
      expect(z.globalRegistry.get(schema)?.id, `${name} is missing .meta({ id })`).toBe(name)
    }
  })

  it('produces a JSON Schema for every entry', () => {
    const out = jsonSchemas()
    expect(Object.keys(out).sort()).toEqual(Object.keys(SCHEMAS).sort())
    for (const [name, schema] of Object.entries(out)) {
      expect(schema, name).toMatchObject({ $schema: 'https://json-schema.org/draft/2020-12/schema' })
    }
  })

  it('never emits a floating-point number for a *Kobo field', () => {
    // Walk the parsed document: find every property named *Kobo, follow a
    // $ref or an anyOf-with-null, and require "integer". Key order irrelevant.
    const seen: string[] = []
    for (const [name, doc] of Object.entries(jsonSchemas())) {
      const defs = (doc as { $defs?: Record<string, unknown> }).$defs ?? {}
      const resolveType = (node: unknown): string | undefined => {
        if (!node || typeof node !== 'object') return undefined
        const n = node as { type?: string; $ref?: string; anyOf?: unknown[] }
        if (n.$ref) return resolveType(defs[n.$ref.replace('#/$defs/', '')])
        if (n.anyOf) return n.anyOf.map(resolveType).find((t) => t !== 'null')
        return n.type
      }
      const walk = (node: unknown) => {
        if (!node || typeof node !== 'object') return
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (key === 'properties' && value && typeof value === 'object') {
            for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) {
              if (prop.endsWith('Kobo')) {
                seen.push(`${name}.${prop}`)
                expect(resolveType(sub), `${name}.${prop}`).toBe('integer')
              }
            }
          }
          walk(value)
        }
      }
      walk(doc)
    }
    expect(seen.length).toBeGreaterThan(10)
  })
})

describe('fixtures', () => {
  it('every fixture validates against its schema', () => {
    expect(SCHEMAS.User.safeParse(exampleUser()).success).toBe(true)
    expect(SCHEMAS.PaymentLink.safeParse(exampleLink()).success).toBe(true)
    expect(SCHEMAS.Payment.safeParse(examplePayment()).success).toBe(true)
    expect(SCHEMAS.DashboardStats.safeParse(exampleStats()).success).toBe(true)
    expect(SCHEMAS.Wallet.safeParse(exampleWallet()).success).toBe(true)
  })

  it('a dashboard event carries the stats snapshot it was computed with', () => {
    const ok = DashboardEventSchema.safeParse({ type: 'payment.completed', payment: examplePayment(), stats: exampleStats() })
    expect(ok.success).toBe(true)
    const missing = DashboardEventSchema.safeParse({ type: 'payment.completed', payment: examplePayment() })
    expect(missing.success).toBe(false)
    expect(DashboardEventSchema.safeParse({ type: 'made.up' }).success).toBe(false)
  })
})
