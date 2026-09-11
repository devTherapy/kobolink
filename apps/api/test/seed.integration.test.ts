import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verify } from '@node-rs/argon2'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '../src/db/schema/index.js'
import { SEED_MERCHANT_EMAIL, seed } from '../src/db/seed.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationsFolder = path.resolve(here, '../drizzle')

const TEST_MERCHANT_PASSWORD = 'a-perfectly-good-test-password'

/**
 * B1's own done-when: "a seed script populates a merchant," proved
 * idempotent by running it twice against one real, migrated Postgres
 * container and finding exactly one merchant, one `merchant_receivable`
 * account and the same two links either way. These two tests run in file
 * order against one shared container: the first proves the no-password
 * skip path on an empty database, the second then supplies a password and
 * proves the merchant actually gets created and reused idempotently.
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

  it('with no SEED_MERCHANT_PASSWORD, skips merchant creation but still creates the external_funding account', async () => {
    const activePool = getPool()

    const result = await seed(getDb(), undefined)

    expect(result.skippedMerchant).toBe(true)
    expect(result.merchantUserId).toBeNull()
    expect(result.merchantReceivableAccountId).toBeNull()
    expect(result.linkCodes).toBeNull()

    const merchants = await activePool.query(`select 1 from users where email = $1`, [SEED_MERCHANT_EMAIL])
    expect(merchants.rows).toHaveLength(0)

    const externalFunding = await activePool.query<{ id: string; owner_user_id: string | null }>(
      `select id, owner_user_id from ledger_accounts where kind = 'external_funding'`,
    )
    expect(externalFunding.rows).toHaveLength(1)
    expect(externalFunding.rows[0]?.id).toBe(result.externalFundingAccountId)
    expect(externalFunding.rows[0]?.owner_user_id).toBeNull()
  })

  it('with a password, running the seed twice leaves exactly one merchant (with a real argon2id hash), one merchant_receivable account, the same two links, and still one external_funding account', async () => {
    const activeDb = getDb()
    const activePool = getPool()

    const first = await seed(activeDb, TEST_MERCHANT_PASSWORD)
    const second = await seed(activeDb, TEST_MERCHANT_PASSWORD)

    expect(first.skippedMerchant).toBe(false)
    expect(second.merchantUserId).toBe(first.merchantUserId)
    expect(second.merchantReceivableAccountId).toBe(first.merchantReceivableAccountId)
    expect(second.linkCodes).toEqual(first.linkCodes)
    expect(second.externalFundingAccountId).toBe(first.externalFundingAccountId)

    const merchants = await activePool.query<{ id: string; role: string; password_hash: string }>(
      `select id, role, password_hash from users where email = $1`,
      [SEED_MERCHANT_EMAIL],
    )
    expect(merchants.rows).toHaveLength(1)
    expect(merchants.rows[0]?.role).toBe('merchant')
    expect(merchants.rows[0]?.id).toBe(first.merchantUserId)
    // A real argon2id PHC-format hash — not the B1-round-1 placeholder
    // string, which would make B2's argon2.verify() throw rather than
    // just reject.
    expect(merchants.rows[0]?.password_hash).toMatch(/^\$argon2id\$/)
    await expect(verify(merchants.rows[0]?.password_hash ?? '', TEST_MERCHANT_PASSWORD)).resolves.toBe(true)
    await expect(verify(merchants.rows[0]?.password_hash ?? '', 'the-wrong-password')).resolves.toBe(false)

    const accounts = await activePool.query(
      `select id from ledger_accounts where owner_user_id = $1 and kind = 'merchant_receivable'`,
      [first.merchantUserId],
    )
    expect(accounts.rows).toHaveLength(1)

    const externalFunding = await activePool.query(`select id from ledger_accounts where kind = 'external_funding'`)
    expect(externalFunding.rows).toHaveLength(1)

    const links = await activePool.query<{ code: string }>(`select code from links where merchant_user_id = $1`, [
      first.merchantUserId,
    ])
    expect(links.rows).toHaveLength(2)
    expect(links.rows.map((row) => row.code).sort()).toEqual([...(first.linkCodes ?? [])].sort())
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
