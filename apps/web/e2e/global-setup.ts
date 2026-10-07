import { E2E_APPLE_APP_ID, startStack } from './support/stack'

/**
 * Starts the full stack once for the run and returns its teardown (Playwright
 * runs a function returned from `globalSetup` after the last test).
 *
 * `EXPECTED_APP_ID` is what `associations.spec.ts` compares the served AASA
 * against; setting it here, to the placeholder the stack was started with,
 * means that guard runs in `npm run test:e2e` instead of skipping.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  // Assigned, not defaulted: a developer's own EXPECTED_APP_ID (for
  // `npm run smoke`) names a different server than the one started here.
  process.env.EXPECTED_APP_ID = E2E_APPLE_APP_ID
  const stack = await startStack()
  return stack.stop
}
