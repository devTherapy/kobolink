import { setupServer } from 'msw/node'
import { handlers } from './handlers'

/**
 * The Node MSW server used by Vitest + RTL. `src/test/setup.ts` starts it
 * with `onUnhandledRequest: 'error'` — a component reaching for an endpoint
 * with no handler is a bug in the test or the handler set, never a silent
 * pass-through to a network that does not exist in this workspace.
 */
export const server = setupServer(...handlers)
