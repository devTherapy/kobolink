import { describe, expect, it } from 'vitest'
import { MOCK_SESSION_COOKIE_NAME, MOCK_SESSION_TOKEN, REVOKED_SESSION_TOKEN } from '@/mocks/handlers'
import { getSession } from './session'

/**
 * `getSession` is exercised with an explicit `cookieHeader` argument rather
 * than mocking `next/headers` — see its own doc comment for why that
 * parameter exists. This is the same "forwarded cookie" contract
 * `middleware.ts` and the dashboard layout both rely on, tested directly
 * against the mock `auth.me` handler in `src/mocks/handlers.ts`.
 */
describe('getSession', () => {
  it('returns null with no cookie header at all — never calls the network', async () => {
    const session = await getSession('')
    expect(session).toBeNull()
  })

  it('returns the signed-in user for a valid session cookie', async () => {
    const session = await getSession(`${MOCK_SESSION_COOKIE_NAME}=${MOCK_SESSION_TOKEN}`)
    expect(session).not.toBeNull()
    expect(session?.user.email).toBeTruthy()
  })

  it('returns null for a stale/revoked session cookie (auth.me 401s)', async () => {
    const session = await getSession(`${MOCK_SESSION_COOKIE_NAME}=${REVOKED_SESSION_TOKEN}`)
    expect(session).toBeNull()
  })

  it('returns null when the cookie header carries only unrelated cookies', async () => {
    const session = await getSession('some_other_cookie=1')
    expect(session).toBeNull()
  })
})
