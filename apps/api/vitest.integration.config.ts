import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// Integration tests: `test/**/*.integration.test.ts`, real HTTP against a
// real Nest app, real Postgres via Testcontainers. Serial and generously
// timed — starting a container is slow, and running two suites' containers
// concurrently on a laptop or a CI runner is more likely to flake than to
// save wall-clock time.
//
// The swc plugin makes constructor-injected providers (`DbService`,
// `ConfigService`, everything `Test.createTestingModule` wires up) resolve
// correctly — see the comment in vitest.config.ts for why esbuild's default
// transform cannot do this.
export default defineConfig({
  plugins: [swc.vite()],
  test: {
    include: ['test/**/*.integration.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
