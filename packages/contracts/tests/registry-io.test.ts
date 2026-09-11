import { describe, expect, it } from 'vitest'
import { EmailSchema, PhoneSchema, jsonSchemas } from '../src/index.js'

type JsonObject = Record<string, unknown>
const defs = (name: keyof ReturnType<typeof jsonSchemas>) =>
  (jsonSchemas()[name] as { $defs: Record<string, JsonObject> }).$defs

describe('jsonSchemas — what the generated Swift and Kotlin models will see', () => {
  it('emits Phone and Email as typed strings, not untyped transforms', () => {
    const user = defs('User')
    expect(user.Phone).toMatchObject({ type: 'string', pattern: '^\\+234[789][01]\\d{8}$' })
    expect(user.Email).toMatchObject({ type: 'string', format: 'email' })
  })

  it('does not require defaulted fields on a request — a client may omit them', () => {
    const create = defs('CreateLinkRequest').CreateLinkRequest as { required: string[] }
    expect(create.required).toEqual(['title'])
    const login = defs('LoginRequest').LoginRequest as { required: string[] }
    expect(login.required.sort()).toEqual(['email', 'password'])
  })

  it('always requires derived fields on a response — the server never omits them', () => {
    const link = defs('PaymentLink').PaymentLink as { required: string[] }
    expect(link.required).toContain('paymentCount')
    expect(link.required).toContain('totalPaidKobo')
  })
})

describe('EmailSchema', () => {
  it('trims and lowercases before validating, so a trailing keyboard space is not an error', () => {
    expect(EmailSchema.parse('  Ngozi@Example.COM ')).toBe('ngozi@example.com')
    expect(EmailSchema.safeParse('not an email').success).toBe(false)
  })
})

describe('PhoneSchema wire form', () => {
  it('outputs E.164 that matches its own published pattern', () => {
    const out = PhoneSchema.parse(' 0803 123 4567 ')
    expect(out).toMatch(/^\+234[789][01]\d{8}$/)
  })
})
