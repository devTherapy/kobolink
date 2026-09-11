import { DrizzleQueryError } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { safeLogDetail } from './log-redaction.js'

describe('safeLogDetail', () => {
  it('redacts params from a DrizzleQueryError, keeping the parameterised SQL and the pg error code/constraint', () => {
    const pgCause = Object.assign(new Error('duplicate key value violates unique constraint "sessions_token_hash_unique"'), {
      code: '23505',
      constraint: 'sessions_token_hash_unique',
    })
    const exception = new DrizzleQueryError(
      'insert into "sessions" ("id","user_id","token_hash","expires_at") values ($1,$2,$3,$4)',
      ['sess_abc123', 'user_1', '$argon2id$v=19$m=19456,t=2,p=1$deadbeefcafebabe', '2026-10-01T00:00:00.000Z'],
      pgCause,
    )

    const detail = safeLogDetail(exception)

    expect(detail).not.toContain('$argon2id$')
    expect(detail).not.toContain('deadbeefcafebabe')
    expect(detail).not.toContain('sess_abc123')
    expect(detail).toContain('code=23505')
    expect(detail).toContain('sessions_token_hash_unique')
    expect(detail).toContain('insert into "sessions"')
  })

  it('still redacts params when the DrizzleQueryError has no recognisable pg cause', () => {
    const exception = new DrizzleQueryError('select 1', ['some-secret-looking-value'])

    const detail = safeLogDetail(exception)

    expect(detail).not.toContain('some-secret-looking-value')
    expect(detail).toContain('code=unknown')
  })

  it('logs the full stack for a normal Error, unredacted', () => {
    const error = new Error('boom')
    expect(safeLogDetail(error)).toBe(error.stack)
  })

  it('falls back to message when an Error has no stack', () => {
    const error = new Error('boom')
    Object.defineProperty(error, 'stack', { value: undefined })
    expect(safeLogDetail(error)).toBe('boom')
  })

  it('stringifies a thrown non-Error value', () => {
    expect(safeLogDetail('a string was thrown')).toBe('a string was thrown')
  })
})
