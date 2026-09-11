import { defineConfig } from 'drizzle-kit'

/**
 * `npx drizzle-kit generate` diffs `src/db/schema.ts` against `drizzle/` and
 * writes a new migration. `DbService`'s Testcontainers-backed integration
 * tests apply the same `drizzle/` folder with `drizzle-orm`'s migrator, so
 * what `generate` produces here is exactly what boots against a real
 * container. There is nothing to generate until B1 adds tables.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://kobolink:kobolink@localhost:5432/kobolink',
  },
})
