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
 * Review finding (round 2): 0001's balance trigger and 0002's append-only
 * triggers together stop a posting's *own* entries from ever changing —
 * but neither stops a brand-new, later transaction from INSERTing a
 * brand-new, internally-balanced pair of entries against an *old*,
 * already-committed `posting_id`. That new pair balances to zero on its
 * own (0001 is satisfied) and nothing is UPDATEd or DELETEd (0002 never
 * fires), yet the posting's meaning still changed after the fact.
 *
 * `drizzle/0003_ledger_entries_posting_same_transaction.sql` closes this:
 * a `ledger_entries` row may only reference a posting created in the same
 * transaction as the insert. This file proves it — a posting created and
 * committed in one transaction cannot receive further entries from any
 * other transaction, while entries inserted in the *same* transaction as
 * their posting (B5's real write path) succeed exactly as before.
 */
describe('ledger_entries can only post against a posting from the same transaction (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer | undefined
  let pool: Pool | undefined
  let externalFundingAccountId: string | undefined

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    pool = new Pool({ connectionString: container.getConnectionUri() })
    await migrate(drizzle(pool), { migrationsFolder })

    externalFundingAccountId = randomUUID()
    await getPool().query(
      `insert into ledger_accounts (id, owner_user_id, kind) values ($1, null, 'external_funding')`,
      [externalFundingAccountId],
    )
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    await container?.stop()
  })

  it('rejects a balanced pair inserted, in a new transaction, against a posting committed by an earlier transaction', async () => {
    const setupClient = await getPool().connect()
    let postingId: string
    let walletAccountId: string
    try {
      walletAccountId = await insertWalletAccount(setupClient)
      postingId = await insertPosting(setupClient) // autocommits — no explicit transaction here
    } finally {
      setupClient.release()
    }

    const laterClient = await getPool().connect()
    try {
      await laterClient.query('begin')
      try {
        await expect(
          laterClient.query(
            `insert into ledger_entries (id, posting_id, account_id, amount_kobo) values
               ($1, $3, $4, 60000),
               ($2, $3, $5, -60000)`,
            [randomUUID(), randomUUID(), postingId, walletAccountId, getExternalFundingAccountId()],
          ),
        ).rejects.toThrow(/does not reference a posting created in the current transaction/)
      } finally {
        // Always roll back, even if the assertion above itself throws (a
        // wrong expectation, say) — otherwise this connection goes back to
        // the pool mid-transaction-and-aborted, and whichever test borrows
        // it next fails with an unrelated "current transaction is aborted"
        // instead of the real problem.
        await laterClient.query('rollback')
      }
    } finally {
      laterClient.release()
    }
  })

  it('still allows entries inserted in the same transaction that creates their posting — the normal B5 write path', async () => {
    const client = await getPool().connect()
    try {
      const walletAccountId = await insertWalletAccount(client)

      await client.query('begin')
      const postingId = randomUUID()
      await client.query(`insert into postings (id, kind, reference) values ($1, 'link_payment', $2)`, [
        postingId,
        `test-${randomUUID()}`,
      ])
      await expect(
        client.query(
          `insert into ledger_entries (id, posting_id, account_id, amount_kobo) values
             ($1, $3, $4, 45000),
             ($2, $3, $5, -45000)`,
          [randomUUID(), randomUUID(), postingId, walletAccountId, getExternalFundingAccountId()],
        ),
      ).resolves.toBeDefined()
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
