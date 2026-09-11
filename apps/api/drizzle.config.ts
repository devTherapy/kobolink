import { defineConfig } from 'drizzle-kit'

/**
 * `npx drizzle-kit generate` diffs `src/db/schema.ts` against `drizzle/` and
 * writes a new migration. `DbService`'s Testcontainers-backed integration
 * tests apply the same `drizzle/` folder with `drizzle-orm`'s migrator, so
 * what `generate` produces here is exactly what boots against a real
 * container. There is nothing to generate until B1 adds tables.
 *
 * `DATABASE_URL` is required, not defaulted — a fallback connection string
 * checked into source is a credential in tracked code even when it only
 * ever points at a local dev database. Copy `apps/api/.env.example` (or the
 * repo root's) to `.env.local` to run this locally; CI and the
 * Testcontainers-backed tests supply their own real one and never reach
 * this file.
 */
const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error(
    'DATABASE_URL is not set. drizzle-kit needs it to connect — see apps/api/.env.example, copy it to .env.local, and export it (or run drizzle-kit with dotenv-cli).',
  )
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: databaseUrl,
  },
})
