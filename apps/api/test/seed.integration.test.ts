import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '../src/db/schema/index.js'
import { SEED_MERCHANT_EMAIL, seed } from '../src/db/seed.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationsFolder = path.resolve(here, '../drizzle')

/**
 * B1's own done-when: "a seed script populates a merchant," proved
 * idempotent by running it twice against one real, migrated Postgres
 * container and finding exactly one merchant, one `merchant_receivable`
 * account and the same two links either way.
 */
describe('db seed (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer | undefined
  let pool: Pool | undefined
  let db: ReturnType<typeof drizzle<typeof schema>> | undefined

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    pool = new Pool({ connectionString: container.getConnectionUri() })
    await migrate(drizzle(pool), { migrationsFolder })
    db = drizzle(pool, { schema })
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    await container?.stop()
  })

  it('running the seed twice leaves exactly one merchant, one merchant_receivable account, and the same two links', async () => {
    const activeDb = getDb()
    const activePool = getPool()

    const first = await seed(activeDb)
    const second = await seed(activeDb)

    expect(second.merchantUserId).toBe(first.merchantUserId)
    expect(second.merchantReceivableAccountId).toBe(first.merchantReceivableAccountId)
    expect(second.linkCodes).toEqual(first.linkCodes)

    const merchants = await activePool.query<{ id: string; role: string }>(
      `select id, role from users where email = $1`,
      [SEED_MERCHANT_EMAIL],
    )
    expect(merchants.rows).toHaveLength(1)
    expect(merchants.rows[0]?.role).toBe('merchant')
    expect(merchants.rows[0]?.id).toBe(first.merchantUserId)

    const accounts = await activePool.query(
      `select id from ledger_accounts where owner_user_id = $1 and kind = 'merchant_receivable'`,
      [first.merchantUserId],
    )
    expect(accounts.rows).toHaveLength(1)

    const links = await activePool.query<{ code: string }>(`select code from links where merchant_user_id = $1`, [
      first.merchantUserId,
    ])
    expect(links.rows).toHaveLength(2)
    expect(links.rows.map((row) => row.code).sort()).toEqual([...first.linkCodes].sort())
  })

  function getDb(): ReturnType<typeof drizzle<typeof schema>> {
    if (db === undefined) throw new Error('beforeAll did not produce a db client — see its own failure above')
    return db
  }

  function getPool(): Pool {
    if (pool === undefined) throw new Error('beforeAll did not produce a pool — see its own failure above')
    return pool
  }
})
