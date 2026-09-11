import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// Unit tests only: colocated `src/**/*.spec.ts`, pure logic, no Docker, no
// network. `npm run test` (and therefore CI's `unit` job) must never touch
// Testcontainers — that is what `test:api` and vitest.integration.config.ts
// are for.
//
// The swc plugin is what makes Nest's `@Injectable()`-style DI resolvable
// under Vitest at all: Vite's default esbuild transform strips decorators
// without emitting the `design:paramtypes` metadata `reflect-metadata`
// needs, so any spec that goes through Nest's injector (`Test.createTestingModule`)
// would silently receive `undefined` for every constructor parameter.
export default defineConfig({
  plugins: [swc.vite()],
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    // Explicit rather than relying on some other import incidentally
    // side-loading it first: `Reflect.getMetadata`/`defineMetadata` do not
    // exist on the platform `Reflect` object at all until this package
    // patches it in, and swc's decorator-metadata output calls them
    // directly, the same as `tsc`'s does.
    setupFiles: ['reflect-metadata'],
  },
})
