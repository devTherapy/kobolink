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
    const json = JSON.stringify(jsonSchemas())
    // Every property whose name ends in Kobo must be "type":"integer".
    const koboProps = json.match(/"[A-Za-z]*Kobo":\{"type":"[a-z]+"/g) ?? []
    expect(koboProps.length).toBeGreaterThan(5)
    for (const prop of koboProps) expect(prop).toMatch(/"type":"integer"$/)
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
