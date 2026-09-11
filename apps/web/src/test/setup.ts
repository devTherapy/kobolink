import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { API } from '@kobolink/contracts'
import { server } from '@/mocks/server'
import { resetMockState } from '@/mocks/state'

/**
 * `onUnhandledRequest: 'error'` — a component reaching for an endpoint with
 * no MSW handler fails the test loudly instead of hitting a network that
 * does not exist in this workspace (§ F0 "Done when": no backend running).
 */
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(async () => {
  server.resetHandlers()
  // The handler set is stateful (created/patched links, checkout sessions,
  // idempotency replays, the wallet balance) — reset it too, or one test's
  // writes leak into the next.
  resetMockState()
  // MSW (since ~v2.7) ships its own internal cookie jar: any mocked
  // response's `Set-Cookie` is stored and automatically re-attached to
  // later requests to the same origin — real cookie-jar behaviour, not
  // something this app's handlers opted into. F2's auth handlers rely on
  // exactly that persistence within one test (register/login really does
  // leave a merchant "signed in" for a later `auth.me` call in the same
  // test) — but the jar is a module-level singleton, so left alone it also
  // leaks a session cookie from one test into the next one's "signed out"
  // assertion. Clearing it the same way a real logout would — a matched
  // request answering an already-expired `Set-Cookie` for the session
  // cookie — undoes that between every test, the same as `resetMockState()`
  // undoes the in-memory store above.
  await fetch('http://localhost:3000' + API.auth.logout, { method: 'POST' })
  cleanup()
})
afterAll(() => server.close())
