import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationsFolder = path.resolve(here, '../drizzle')

/**
 * "Add a DB-level constraint or trigger that enforces 'entries within a
 * posting sum to zero' if you can do it cleanly in Postgres" — this proves
 * the deferred constraint trigger from
 * `drizzle/0001_ledger_entries_balance_trigger.sql` actually holds, using
 * raw SQL against a real container rather than going through the Drizzle
 * query builder, so nothing in an application layer is standing in the
 * way of what Postgres itself will or won't allow.
 *
 * Rows are inserted with explicit ids (`$defaultFn` in schema/id.ts only
 * runs inside the Drizzle query builder, not for a raw `INSERT`) — that is
 * expected, not worked around: raw SQL bypassing an application-level
 * default is exactly the situation the trigger exists to hold the line on
 * regardless of what wrote the rows.
 */
describe('ledger_entries balance trigger (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer | undefined
  let pool: Pool | undefined
  let externalFundingAccountId: string | undefined

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    pool = new Pool({ connectionString: container.getConnectionUri() })
    await migrate(drizzle(pool), { migrationsFolder })

    // The counterparty side of every test's posting. Ownerless, and the
    // schema allows at most one such row — created once here, reused by
    // every test below rather than per-test (a second insert would violate
    // ledger_accounts_external_funding_singleton).
    externalFundingAccountId = randomUUID()
    await getPool().query(`insert into ledger_accounts (id, owner_user_id, kind) values ($1, null, 'external_funding')`, [
      externalFundingAccountId,
    ])
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    await container?.stop()
  })

  it('commits when a posting\'s entries sum to zero', async () => {
    const client = await getPool().connect()
    try {
      await client.query('begin')
      const walletAccountId = await insertWalletAccount(client)
      const postingId = await insertPosting(client)

      await client.query(
        `insert into ledger_entries (id, posting_id, account_id, amount_kobo) values
           ($1, $3, $4, 50000),
           ($2, $3, $5, -50000)`,
        [randomUUID(), randomUUID(), postingId, walletAccountId, getExternalFundingAccountId()],
      )

      await expect(client.query('commit')).resolves.toBeDefined()
    } finally {
      client.release()
    }
  })

  it('the commit itself fails when a posting\'s entries do not sum to zero', async () => {
    const client = await getPool().connect()
    try {
      await client.query('begin')
      const walletAccountId = await insertWalletAccount(client)
      const postingId = await insertPosting(client)

      // Only one leg of the transfer — never balances to zero.
      await client.query(`insert into ledger_entries (id, posting_id, account_id, amount_kobo) values ($1, $2, $3, 50000)`, [
        randomUUID(),
        postingId,
        walletAccountId,
      ])

      await expect(client.query('commit')).rejects.toThrow(/do not balance to zero/)
    } finally {
      // The failed COMMIT already ended the transaction; nothing to roll back explicitly, but
      // a fresh client from the pool for the next test still needs this one released.
      client.release()
    }
  })

  it('the check is deferred to commit time, not fired immediately after the first, still-unbalanced row', async () => {
    const client = await getPool().connect()
    try {
      await client.query('begin')
      const walletAccountId = await insertWalletAccount(client)
      const postingId = await insertPosting(client)

      // If the trigger fired immediately (not DEFERRABLE INITIALLY
      // DEFERRED), this single-row, deliberately unbalanced insert would
      // already throw here.
      await expect(
        client.query(`insert into ledger_entries (id, posting_id, account_id, amount_kobo) values ($1, $2, $3, 50000)`, [
          randomUUID(),
          postingId,
          walletAccountId,
        ]),
      ).resolves.toBeDefined()

      // The balancing leg, still inside the same transaction.
      await client.query(`insert into ledger_entries (id, posting_id, account_id, amount_kobo) values ($1, $2, $3, -50000)`, [
        randomUUID(),
        postingId,
        getExternalFundingAccountId(),
      ])

      await expect(client.query('commit')).resolves.toBeDefined()
    } finally {
      client.release()
    }
  })

  async function insertWalletAccount(client: PoolClient): Promise<string> {
    const userId = randomUUID()
    await client.query(
      `insert into users (id, role, email, password_hash, display_name)
       values ($1, 'customer', $2, 'not-a-real-hash', 'Test Customer')`,
      [userId, `${userId}@example.test`],
    )
    const accountId = randomUUID()
    await client.query(`insert into ledger_accounts (id, owner_user_id, kind) values ($1, $2, 'wallet')`, [
      accountId,
      userId,
    ])
    return accountId
  }

  async function insertPosting(client: PoolClient): Promise<string> {
    const postingId = randomUUID()
    await client.query(`insert into postings (id, kind, reference) values ($1, 'transfer', $2)`, [
      postingId,
      `test-${randomUUID()}`,
    ])
    return postingId
  }

  function getPool(): Pool {
    if (pool === undefined) throw new Error('beforeAll did not produce a pool — see its own failure above')
    return pool
  }

  function getExternalFundingAccountId(): string {
    if (externalFundingAccountId === undefined) {
      throw new Error('beforeAll did not produce the external_funding account — see its own failure above')
    }
    return externalFundingAccountId
  }
})
