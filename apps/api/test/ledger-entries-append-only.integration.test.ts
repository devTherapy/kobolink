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
 * Review finding (B1 round 1): the balance trigger alone
 * (`drizzle/0001_ledger_entries_balance_trigger.sql`) only re-sums the
 * posting(s) touched by the statement that fired it. Reproduced here
 * before the fix, and now asserted against: posting pA has a balanced
 * +500/-500, posting pB has a balanced +700/-700; moving one of pA's rows
 * onto pB and zeroing its amount (`UPDATE ledger_entries SET posting_id =
 * 'pB', amount_kobo = 0 WHERE id = 'e1'`) used to commit cleanly, leaving
 * pA permanently at -500 with nothing left to notice. Deleting a row out
 * of an otherwise-balanced posting passed the same way.
 *
 * `drizzle/0002_ledger_entries_append_only.sql` closes that by rejecting
 * every UPDATE and DELETE on `ledger_entries` and `postings` outright —
 * this file is the proof, covering exactly the three review-listed cases
 * (move an entry between postings, delete an entry, edit an amount) plus
 * the `postings` side of the same trigger function, plus (round 2)
 * `TRUNCATE` on both tables — a statement row-level triggers never see at
 * all, so 0002 also registers a `FOR EACH STATEMENT` pair specifically for
 * it.
 *
 * Every "setup" insert of a posting that will receive entries happens
 * inside the *same* transaction as those entries, and commits before the
 * mutation under test begins a new one. That is not incidental style here
 * — `0003_ledger_entries_posting_same_transaction.sql` (round 2) means a
 * posting created via an earlier, separately-committed statement could no
 * longer receive entries at all, so setup that used to be able to run
 * outside any explicit transaction no longer can.
 *
 * Every "expect this to be rejected" assertion is wrapped so the
 * transaction is rolled back in a `finally`, not just after a successful
 * assertion — a wrong expectation (this file had one, first time round: a
 * regex that didn't match the trigger's actual message) throws from
 * `expect(...).rejects.toThrow(...)` itself, and skipping the rollback on
 * that path leaves the pooled connection stuck "in a transaction that is
 * aborted" for whatever test borrows it next — a confusing cascade of
 * unrelated failures for what was really one wrong regex.
 */
describe('ledger_entries / postings append-only trigger (real Postgres via Testcontainers)', () => {
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

  it('rejects moving an entry from one posting to another — the exact reproduction the review reported', async () => {
    const client = await getPool().connect()
    try {
      await client.query('begin')
      const walletA = await insertWalletAccount(client)
      const walletB = await insertWalletAccount(client)
      const postingA = await insertPosting(client)
      const postingB = await insertPosting(client)

      const entryToMove = randomUUID()
      await client.query(
        `insert into ledger_entries (id, posting_id, account_id, amount_kobo) values
           ($1, $3, $4, 50000),
           ($2, $3, $5, -50000)`,
        [entryToMove, randomUUID(), postingA, walletA, getExternalFundingAccountId()],
      )
      await client.query(
        `insert into ledger_entries (id, posting_id, account_id, amount_kobo) values
           ($1, $3, $4, 70000),
           ($2, $3, $5, -70000)`,
        [randomUUID(), randomUUID(), postingB, walletB, getExternalFundingAccountId()],
      )
      await client.query('commit') // both postings, and their entries, balanced and durable before the mutation under test

      await client.query('begin')
      try {
        await expect(
          client.query(`update ledger_entries set posting_id = $1, amount_kobo = 0 where id = $2`, [
            postingB,
            entryToMove,
          ]),
        ).rejects.toThrow(/append-only/)
      } finally {
        await client.query('rollback')
      }
    } finally {
      client.release()
    }
  })

  it('rejects deleting an entry out of an otherwise-balanced posting', async () => {
    const client = await getPool().connect()
    try {
      await client.query('begin')
      const walletAccountId = await insertWalletAccount(client)
      const postingId = await insertPosting(client)
      const entryId = randomUUID()

      await client.query(
        `insert into ledger_entries (id, posting_id, account_id, amount_kobo) values
           ($1, $3, $4, 50000),
           ($2, $3, $5, -50000)`,
        [entryId, randomUUID(), postingId, walletAccountId, getExternalFundingAccountId()],
      )
      await client.query('commit')

      await client.query('begin')
      try {
        await expect(client.query(`delete from ledger_entries where id = $1`, [entryId])).rejects.toThrow(
          /append-only/,
        )
      } finally {
        await client.query('rollback')
      }
    } finally {
      client.release()
    }
  })

  it("rejects updating an entry's amount in place", async () => {
    const client = await getPool().connect()
    try {
      await client.query('begin')
      const walletAccountId = await insertWalletAccount(client)
      const postingId = await insertPosting(client)
      const entryId = randomUUID()

      await client.query(
        `insert into ledger_entries (id, posting_id, account_id, amount_kobo) values
           ($1, $3, $4, 50000),
           ($2, $3, $5, -50000)`,
        [entryId, randomUUID(), postingId, walletAccountId, getExternalFundingAccountId()],
      )
      await client.query('commit')

      await client.query('begin')
      try {
        await expect(
          client.query(`update ledger_entries set amount_kobo = 1 where id = $1`, [entryId]),
        ).rejects.toThrow(/append-only/)
      } finally {
        await client.query('rollback')
      }
    } finally {
      client.release()
    }
  })

  it('rejects updating and deleting a posting row itself, not only its entries', async () => {
    const client = await getPool().connect()
    try {
      // No explicit transaction needed here: 0002's trigger fires on
      // UPDATE/DELETE of `postings` directly, unrelated to
      // 0003 (which only governs INSERTs into `ledger_entries`) — the
      // posting is never asked to receive an entry in this test.
      const postingId = await insertPosting(client)

      await expect(
        client.query(`update postings set reference = $1 where id = $2`, [`changed-${randomUUID()}`, postingId]),
      ).rejects.toThrow(/append-only/)
      await expect(client.query(`delete from postings where id = $1`, [postingId])).rejects.toThrow(/append-only/)
    } finally {
      client.release()
    }
  })

  it('rejects TRUNCATE on ledger_entries and postings — row-level triggers alone do not fire for TRUNCATE', async () => {
    const client = await getPool().connect()
    try {
      // Round 2 review finding: `FOR EACH ROW` triggers (the ones above)
      // never fire for TRUNCATE at all — only `FOR EACH STATEMENT`
      // triggers do. Without those, TRUNCATE would have silently bypassed
      // every invariant this file otherwise proves.
      await expect(client.query('truncate ledger_entries')).rejects.toThrow(/append-only.*truncate/i)

      // `TRUNCATE postings` *alone* is refused by Postgres itself before
      // any trigger runs — a plain TRUNCATE never implicitly follows a
      // foreign key the way DELETE does, and ledger_entries.posting_id
      // references postings.id, so this is Postgres's own protection, not
      // this migration's. CASCADE (or listing both tables together, as
      // the third case below does) is what actually reaches the trigger.
      await expect(client.query('truncate postings')).rejects.toThrow(/foreign key/i)
      await expect(client.query('truncate postings cascade')).rejects.toThrow(/append-only.*truncate/i)
      await expect(client.query('truncate ledger_entries, postings')).rejects.toThrow(/append-only.*truncate/i)
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
