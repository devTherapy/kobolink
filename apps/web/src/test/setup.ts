import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { server } from '@/mocks/server'
import { resetMockState } from '@/mocks/state'

/**
 * `onUnhandledRequest: 'error'` — a component reaching for an endpoint with
 * no MSW handler fails the test loudly instead of hitting a network that
 * does not exist in this workspace (§ F0 "Done when": no backend running).
 */
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  // The handler set is stateful (created/patched links, checkout sessions,
  // idempotency replays, the wallet balance) — reset it too, or one test's
  // writes leak into the next.
  resetMockState()
  cleanup()
})
afterAll(() => server.close())
