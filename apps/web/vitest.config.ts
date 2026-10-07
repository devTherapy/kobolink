import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'web',
          include: ['src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
        },
      },
      {
        // Helpers of the Playwright harness (`e2e/support`). A project of its own
        // because they use real sockets, which the web project's MSW setup
        // (`onUnhandledRequest: 'error'`) intercepts. `.unit.ts`, not `.test.ts`:
        // Playwright's default testMatch would otherwise run these as e2e specs.
        extends: true,
        test: {
          name: 'e2e-support',
          include: ['e2e/support/**/*.unit.ts'],
          environment: 'node',
        },
      },
    ],
    css: false,
    restoreMocks: true,
    // The default 5000ms is tight for a `userEvent`-driven form test (real
    // timers, real async MSW round-trips) once the full suite's ~30 files
    // run concurrently and contend for CPU — a handful of otherwise-healthy
    // tests (a different one each run) intermittently tripped it under load
    // even though each passes in well under 1s in isolation. Widening the
    // budget, not the pool's concurrency, keeps the suite's wall-clock time
    // down while giving a contended run enough room to finish for real.
    testTimeout: 15000,
  },
})
