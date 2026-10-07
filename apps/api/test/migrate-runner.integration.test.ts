import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../src/db/migrate.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const journalPath = path.resolve(here, '../drizzle/meta/_journal.json')

/**
 * The production `release_command` (`node dist/db/migrate.js`) is a thin
 * wrapper around `runMigrations`; this proves the function against a real,
 * empty Postgres: it creates the schema, and a second run on an up-to-date
 * database is a no-op rather than an error.
 */
describe('runMigrations (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer | undefined

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
  }, 120_000)

  afterAll(async () => {
    await container?.stop()
  })

  it('applies the migrations to an empty database and is idempotent', async () => {
    const url = container?.getConnectionUri()
    if (url === undefined) throw new Error('container did not start')

    await runMigrations(url)
    await runMigrations(url)

    const pool = new Pool({ connectionString: url })
    try {
      const tables = await pool.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema = 'public' and table_name in ('users', 'ledger_entries', 'checkout_sessions')`,
      )
      expect(tables.rows.map((row) => row.table_name).sort()).toEqual(['checkout_sessions', 'ledger_entries', 'users'])

      const applied = await pool.query<{ count: string }>(`select count(*) from drizzle.__drizzle_migrations`)
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] }
      expect(Number(applied.rows[0]?.count)).toBe(journal.entries.length)
    } finally {
      await pool.end()
    }
  })
})
