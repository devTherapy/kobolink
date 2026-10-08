import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * `drizzle/` sits next to `src/` and `dist/` in the repo and in the API image
 * (`/app/apps/api/{dist,drizzle}`), so both `src/db/` and `dist/db/` resolve
 * it with the same two `..`.
 */
const defaultMigrationsFolder = path.resolve(here, '../../drizzle')

/**
 * Applies every pending `drizzle/*.sql` migration, in order, and returns.
 * This is the production counterpart of `drizzle-kit migrate`: the same
 * journal and the same `drizzle.__drizzle_migrations` bookkeeping, but built
 * on `drizzle-orm` (a production dependency) so the deployed image does not
 * have to carry `drizzle-kit` and its toolchain just to run the Fly
 * `release_command` (see docs/DEPLOY.md). Idempotent: a second run on an
 * up-to-date database applies nothing.
 *
 * Deliberately a plain `Pool` with no `statement_timeout` — the runtime pool's
 * 5s cap (`DbService`) is right for a request and wrong for a migration.
 */
export async function runMigrations(
  databaseUrl: string,
  migrationsFolder: string = defaultMigrationsFolder,
): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl })
  try {
    await migrate(drizzle(pool), { migrationsFolder })
  } finally {
    await pool.end()
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error('DATABASE_URL is not set. Set it as a Fly secret (docs/DEPLOY.md) or export it locally.')
  }
  await runMigrations(databaseUrl)
  // eslint-disable-next-line no-console -- a CLI entry point reporting that it finished.
  console.info('migrations applied')
}

// Same symlink-safe entry-point check as `seed.ts`.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
