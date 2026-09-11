import { IsoDateTimeSchema } from '@kobolink/contracts'
import { describe, expect, it } from 'vitest'
import { fromIso, toIso } from './iso-timestamp.js'

describe('toIso / fromIso', () => {
  it('toIso produces a string that satisfies the contract\'s IsoDateTimeSchema', () => {
    const iso = toIso(new Date('2026-09-11T12:48:29.861Z'))
    expect(() => IsoDateTimeSchema.parse(iso)).not.toThrow()
    expect(iso).toBe('2026-09-11T12:48:29.861Z')
  })

  it('round-trips a Date through toIso and fromIso to the same instant', () => {
    const original = new Date('2026-01-02T03:04:05.678Z')
    expect(fromIso(toIso(original)).getTime()).toBe(original.getTime())
  })

  it('what mode: "string" would have produced — raw Postgres text — fails the same schema this helper satisfies', () => {
    const rawPostgresText = '2026-09-11 12:48:29.861912+00'
    expect(() => IsoDateTimeSchema.parse(rawPostgresText)).toThrow()
  })
})
