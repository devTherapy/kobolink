// Extends the root flat config (money/promise/switch rules, TS strict
// linting) and layers Next.js's own rules on top. `eslint-config-next`
// exports a flat `Linter.Config[]` directly as of Next 16 — spread it in,
// rather than routing it through `FlatCompat`, which is for legacy
// `.eslintrc`-shaped shareable configs and mis-validates a flat plugin array.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'
import rootConfig from '../../eslint.config.mjs'

const config = [
  ...rootConfig,
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // e2e/associations.spec.ts is intentionally excluded from tsconfig.json
    // (see its "exclude" entry) because @playwright/test is not installed —
    // typed linting would otherwise fail the same "not found by the project
    // service" way the dot-directory route handlers did before that was
    // fixed. F9 removes this ignore alongside the tsconfig one.
    ignores: ['.next/**', 'next-env.d.ts', 'public/mockServiceWorker.js', 'e2e/**'],
  },
]

export default config
