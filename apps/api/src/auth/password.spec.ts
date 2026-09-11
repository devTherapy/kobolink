import { describe, expect, it } from 'vitest'
import { hashPassword, verifyDummyPassword, verifyPassword } from './password.js'

// No Postgres involved — argon2 itself is pure CPU work — but hashing is
// deliberately slow, so this file keeps the case count small.
describe('hashPassword / verifyPassword', () => {
  it('round-trips: a hash verifies against the password that produced it', async () => {
    const passwordHash = await hashPassword('correct horse battery staple')
    await expect(verifyPassword(passwordHash, 'correct horse battery staple')).resolves.toBe(true)
  })

  it('rejects the wrong password', async () => {
    const passwordHash = await hashPassword('correct horse battery staple')
    await expect(verifyPassword(passwordHash, 'wrong password entirely')).resolves.toBe(false)
  })

  it('produces a real argon2id PHC string, not a placeholder', async () => {
    const passwordHash = await hashPassword('correct horse battery staple')
    expect(passwordHash).toMatch(/^\$argon2id\$/)
  })
})

describe('verifyDummyPassword', () => {
  it('always resolves to false', async () => {
    await expect(verifyDummyPassword('anything at all')).resolves.toBe(false)
  })
})
