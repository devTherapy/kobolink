import { describe, expect, it } from 'vitest'
import { asPgError, isUniqueViolation } from './pg-error.js'

describe('asPgError', () => {
  it('reads a plain pg DatabaseError-shaped object directly', () => {
    expect(asPgError({ code: '23505', constraint: 'users_email_unique' })).toEqual({
      code: '23505',
      constraint: 'users_email_unique',
    })
  })

  it('unwraps a DrizzleQueryError-style .cause', () => {
    const cause = { code: '23505', constraint: 'users_email_unique' }
    expect(asPgError({ message: 'Failed query', cause })).toEqual(cause)
  })

  it('unwraps a doubly-nested .cause', () => {
    const inner = { code: '23505', constraint: 'users_email_unique' }
    expect(asPgError({ cause: { cause: inner } })).toEqual(inner)
  })

  it('returns undefined for an unrelated error', () => {
    expect(asPgError(new Error('boom'))).toBeUndefined()
  })

  it('returns undefined for a non-object', () => {
    expect(asPgError('boom')).toBeUndefined()
    expect(asPgError(null)).toBeUndefined()
    expect(asPgError(undefined)).toBeUndefined()
  })
})

describe('isUniqueViolation', () => {
  it('is true for a matching code and constraint', () => {
    expect(isUniqueViolation({ code: '23505', constraint: 'users_email_unique' }, 'users_email_unique')).toBe(true)
  })

  it('is false for the wrong constraint', () => {
    expect(isUniqueViolation({ code: '23505', constraint: 'users_phone_unique' }, 'users_email_unique')).toBe(false)
  })

  it('is false for a different error code', () => {
    expect(isUniqueViolation({ code: '23503', constraint: 'users_email_unique' }, 'users_email_unique')).toBe(false)
  })

  it('is false for a non-pg error', () => {
    expect(isUniqueViolation(new Error('boom'), 'users_email_unique')).toBe(false)
  })
})
