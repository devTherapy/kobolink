import { defineConfig, devices } from '@playwright/test'
import { E2E_WEB_PORT } from './e2e/support/ports'

/**
 * The full-stack suite (PLAN.md F9): a real Postgres container, the built
 * `apps/api`, the built `apps/web`, and a real browser. No MSW anywhere on this
 * path -- `e2e/support/stack.ts` starts the whole stack once, in `globalSetup`,
 * and `journey.spec.ts` asserts no service worker is registered.
 *
 * Two projects, one journey. `desktop` is a 1280px Chromium; `mobile` is a
 * Pixel 7 (412px, touch). Chromium for both: the journey's risk is the SSE
 * stream and the server-rendered page, not engine differences, and each extra
 * engine is another browser download for every contributor.
 *
 * One worker: both projects share the single database. Each test makes its own
 * merchant, so they could overlap, but a loaded laptop is the usual cause of a
 * timing flake in a live-update test and the stack is only started once.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  // A retry would hide exactly the flake this suite exists to catch.
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${E2E_WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
})
