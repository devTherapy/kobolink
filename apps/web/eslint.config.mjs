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
    ignores: ['.next/**', 'next-env.d.ts', 'public/mockServiceWorker.js'],
  },
]

export default config
