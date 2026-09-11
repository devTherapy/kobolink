import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { firstFieldErrors, humanFieldErrors, humanizeFieldIssue, zodIssuesToFields } from './zod-errors'

describe('zodIssuesToFields / firstFieldErrors — server-side field errors', () => {
  it('keeps only the first message per field', () => {
    const fields = { email: ['first', 'second'] }
    expect(firstFieldErrors(fields)).toEqual({ email: 'first' })
  })

  it('zodIssuesToFields groups a ZodError by its first path segment', () => {
    const schema = z.object({ email: z.email() })
    const result = schema.safeParse({ email: 'nope' })
    if (result.success) throw new Error('expected failure')
    expect(zodIssuesToFields(result.error)).toEqual({ email: ['Invalid email address'] })
  })
})

describe('humanizeFieldIssue — rewriting Zod v4 defaults into merchant-facing copy', () => {
  it('turns a length-bounded too_small into "must be at least N characters"', () => {
    const result = z.string().min(10).max(200).safeParse('short')
    if (result.success) throw new Error('expected failure')
    expect(humanizeFieldIssue('password', result.error.issues[0]!)).toBe(
      'Password must be at least 10 characters.',
    )
  })

  it('turns a min(1) too_small into "is required" rather than a character count', () => {
    const result = z.string().min(1).max(200).safeParse('')
    if (result.success) throw new Error('expected failure')
    expect(humanizeFieldIssue('password', result.error.issues[0]!)).toBe('Password is required.')
  })

  it('does the same for an empty required name field', () => {
    const result = z.string().trim().min(1).max(80).safeParse('')
    if (result.success) throw new Error('expected failure')
    expect(humanizeFieldIssue('displayName', result.error.issues[0]!)).toBe('Full name is required.')
  })

  it('rewrites an invalid email format', () => {
    const result = z.email().safeParse('not-an-email')
    if (result.success) throw new Error('expected failure')
    expect(humanizeFieldIssue('email', result.error.issues[0]!)).toBe('Enter a valid email address.')
  })

  it('falls back to the schema message for a field/code this app does not special-case', () => {
    const result = z.number().safeParse('not a number')
    if (result.success) throw new Error('expected failure')
    expect(humanizeFieldIssue('amount', result.error.issues[0]!)).toBe(result.error.issues[0]!.message)
  })
})

describe('humanFieldErrors — a whole safeParse failure', () => {
  it('humanizes every field, keeping only the first issue per field', () => {
    const schema = z.object({ email: z.email(), password: z.string().min(10).max(200) })
    const result = schema.safeParse({ email: 'nope', password: 'short' })
    if (result.success) throw new Error('expected failure')

    expect(humanFieldErrors(result.error)).toEqual({
      email: 'Enter a valid email address.',
      password: 'Password must be at least 10 characters.',
    })
  })
})
