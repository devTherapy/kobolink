import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrateDown } from '../src/db/migrate-down.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationsFolder = path.resolve(here, '../drizzle')

const EXPECTED_TABLES = [
  'idempotency_keys',
  'ledger_accounts',
  'ledger_entries',
  'links',
  'postings',
  'sessions',
  'users',
].sort((a, b) => a.localeCompare(b))

async function publicTables(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
  )
  return result.rows.map((row) => row.table_name)
}

/**
 * B1's own done-when: "`drizzle-kit` migration runs clean up and down."
 * `drizzle-kit`/`drizzle-orm` have no native down migration, so
 * `migrateDown` (src/db/migrate-down.ts) is this repo's stand-in — every
 * `drizzle/<tag>.sql` has a hand-written `<tag>.down.sql` sibling, applied
 * in reverse. This test is the proof that the two stay in sync: a full
 * up → down → up cycle against a real, disposable Postgres container ends
 * exactly where it started, both times.
 */
describe('drizzle migrations: up, down, up again (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer | undefined
  let pool: Pool | undefined

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    pool = new Pool({ connectionString: container.getConnectionUri() })
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    await container?.stop()
  })

  it('migrates up to the full schema, down to empty, and back up to the full schema', async () => {
    const activePool = getPool()

    await migrate(drizzle(activePool), { migrationsFolder })
    expect(await publicTables(activePool)).toEqual(EXPECTED_TABLES)

    const rolledBack = await migrateDown(activePool, { migrationsFolder })
    expect(rolledBack).toBeGreaterThan(0)
    expect(await publicTables(activePool)).toEqual([])

    await migrate(drizzle(activePool), { migrationsFolder })
    expect(await publicTables(activePool)).toEqual(EXPECTED_TABLES)

    // Down again, to prove the cycle is repeatable and not an artefact of
    // running it exactly once, and to leave a clean assertion that calling
    // down with nothing left to roll back is a safe no-op, not an error.
    const secondRollback = await migrateDown(activePool, { migrationsFolder })
    expect(secondRollback).toBeGreaterThan(0)
    expect(await publicTables(activePool)).toEqual([])

    const thirdRollback = await migrateDown(activePool, { migrationsFolder })
    expect(thirdRollback).toBe(0)
  })

  function getPool(): Pool {
    if (pool === undefined) throw new Error('beforeAll did not produce a pool — see its own failure above')
    return pool
  }
})
