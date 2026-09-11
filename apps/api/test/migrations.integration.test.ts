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

const byName = (a: string, b: string): number => a.localeCompare(b)

const EXPECTED_TABLES = [
  'idempotency_keys',
  'ledger_accounts',
  'ledger_entries',
  'links',
  'postings',
  'sessions',
  'users',
].sort(byName)

// The two trigger functions from the hand-written custom migrations
// (0001's deferred balance check, 0002's append-only rejection). Neither
// comes from a declarative pgTable() — drizzle-kit has no way to diff a
// trigger — so nothing but this migration (and this assertion) knows they
// should exist, or should stop existing on the way down.
const EXPECTED_FUNCTIONS = ['check_posting_balance', 'reject_ledger_mutation'].sort(byName)

const EXPECTED_ENUM_TYPES = ['ledger_account_kind', 'link_status', 'posting_kind', 'user_role'].sort(byName)

async function publicTables(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
  )
  return result.rows.map((row) => row.table_name)
}

async function publicFunctions(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ proname: string }>(
    `select p.proname
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
     order by p.proname`,
  )
  return result.rows.map((row) => row.proname)
}

async function publicEnumTypes(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ typname: string }>(
    `select t.typname
     from pg_type t
     join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'public' and t.typtype = 'e'
     order by t.typname`,
  )
  return result.rows.map((row) => row.typname)
}

interface SchemaSnapshot {
  tables: string[]
  functions: string[]
  enumTypes: string[]
}

async function snapshot(pool: Pool): Promise<SchemaSnapshot> {
  return {
    tables: await publicTables(pool),
    functions: await publicFunctions(pool),
    enumTypes: await publicEnumTypes(pool),
  }
}

const EMPTY_SNAPSHOT: SchemaSnapshot = { tables: [], functions: [], enumTypes: [] }
const FULL_SNAPSHOT: SchemaSnapshot = {
  tables: EXPECTED_TABLES,
  functions: EXPECTED_FUNCTIONS,
  enumTypes: EXPECTED_ENUM_TYPES,
}

/**
 * B1's own done-when: "`drizzle-kit` migration runs clean up and down."
 * `drizzle-kit`/`drizzle-orm` have no native down migration, so
 * `migrateDown` (src/db/migrate-down.ts) is this repo's stand-in — every
 * `drizzle/<tag>.sql` has a hand-written `<tag>.down.sql` sibling, applied
 * in reverse. This test is the proof that the two stay in sync: a full
 * up → down → up cycle against a real, disposable Postgres container ends
 * exactly where it started, both times.
 *
 * "Empty" is checked three ways, not just table count — tables, the two
 * hand-written trigger functions, and the four enum types. Review finding
 * (B1 round 1): a `.down.sql` that only drops tables still makes
 * `publicTables` come back empty (`DROP TABLE` on an enum-typed column
 * doesn't touch the enum), so that assertion alone would not have caught a
 * genuinely empty (no-op) `0001_ledger_entries_balance_trigger.down.sql` —
 * the tables would vanish via 0000's own down migration regardless of
 * whether 0001's down did anything at all. Checking `pg_proc`/`pg_type`
 * directly makes a do-nothing custom-migration `.down.sql` fail this test.
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
    expect(await snapshot(activePool)).toEqual(FULL_SNAPSHOT)

    const rolledBack = await migrateDown(activePool, { migrationsFolder })
    expect(rolledBack).toBeGreaterThan(0)
    expect(await snapshot(activePool)).toEqual(EMPTY_SNAPSHOT)

    await migrate(drizzle(activePool), { migrationsFolder })
    expect(await snapshot(activePool)).toEqual(FULL_SNAPSHOT)

    // Down again, to prove the cycle is repeatable and not an artefact of
    // running it exactly once, and to leave a clean assertion that calling
    // down with nothing left to roll back is a safe no-op, not an error.
    const secondRollback = await migrateDown(activePool, { migrationsFolder })
    expect(secondRollback).toBeGreaterThan(0)
    expect(await snapshot(activePool)).toEqual(EMPTY_SNAPSHOT)

    const thirdRollback = await migrateDown(activePool, { migrationsFolder })
    expect(thirdRollback).toBe(0)
  })

  function getPool(): Pool {
    if (pool === undefined) throw new Error('beforeAll did not produce a pool — see its own failure above')
    return pool
  }
})
