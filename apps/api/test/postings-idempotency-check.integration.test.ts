import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationsFolder = path.resolve(here, '../drizzle')

/**
 * Review finding (round 2): `postings_idempotency_scope_key_unique` is a
 * partial unique index on `(idempotency_scope, idempotency_key) WHERE
 * idempotency_key IS NOT NULL`. Postgres unique indexes never treat two
 * NULLs as equal, so that index silently does **not** fire for two rows
 * that both have `idempotency_scope IS NULL` and the exact same non-null
 * `idempotency_key` — exactly the case an idempotency lookup exists to
 * prevent. `CHECK ((idempotency_scope IS NULL) = (idempotency_key IS
 * NULL))`, added to `schema/postings.ts`, closes the gap by forbidding
 * that mixed state outright: a non-null key always requires a non-null
 * scope, which the partial unique index *does* correctly enforce.
 */
describe('postings idempotency_scope/idempotency_key nullability CHECK (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer | undefined
  let pool: Pool | undefined

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    pool = new Pool({ connectionString: container.getConnectionUri() })
    await migrate(drizzle(pool), { migrationsFolder })
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    await container?.stop()
  })

  it('rejects a non-null idempotency_key with a null idempotency_scope', async () => {
    await expect(
      getPool().query(
        `insert into postings (id, kind, reference, idempotency_scope, idempotency_key) values ($1, 'transfer', $2, null, 'k1')`,
        [randomUUID(), `test-${randomUUID()}`],
      ),
    ).rejects.toThrow(/postings_idempotency_scope_key_nullability_matches/)
  })

  it('rejects a non-null idempotency_scope with a null idempotency_key', async () => {
    await expect(
      getPool().query(
        `insert into postings (id, kind, reference, idempotency_scope, idempotency_key) values ($1, 'transfer', $2, 'user_123', null)`,
        [randomUUID(), `test-${randomUUID()}`],
      ),
    ).rejects.toThrow(/postings_idempotency_scope_key_nullability_matches/)
  })

  it('allows both null (a posting kind with no client-idempotent write behind it)', async () => {
    await expect(
      getPool().query(
        `insert into postings (id, kind, reference, idempotency_scope, idempotency_key) values ($1, 'transfer', $2, null, null)`,
        [randomUUID(), `test-${randomUUID()}`],
      ),
    ).resolves.toBeDefined()
  })

  it('allows both non-null, and the partial unique index then does its job on a real duplicate', async () => {
    const reference1 = `test-${randomUUID()}`
    await expect(
      getPool().query(
        `insert into postings (id, kind, reference, idempotency_scope, idempotency_key) values ($1, 'transfer', $2, 'user_123', 'k1')`,
        [randomUUID(), reference1],
      ),
    ).resolves.toBeDefined()

    // Same (scope, key) pair, a different posting — this is the replay
    // case idempotency_keys itself is the real authority over; at the
    // postings level it is simply a uniqueness violation.
    const reference2 = `test-${randomUUID()}`
    await expect(
      getPool().query(
        `insert into postings (id, kind, reference, idempotency_scope, idempotency_key) values ($1, 'transfer', $2, 'user_123', 'k1')`,
        [randomUUID(), reference2],
      ),
    ).rejects.toThrow(/postings_idempotency_scope_key_unique/)
  })

  function getPool(): Pool {
    if (pool === undefined) throw new Error('beforeAll did not produce a pool — see its own failure above')
    return pool
  }
})
