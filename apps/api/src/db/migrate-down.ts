import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Pool } from 'pg'

/**
 * `drizzle-kit`/`drizzle-orm` have no native "down" migration — `migrate()`
 * only ever moves forward. The documented mechanism this repo uses instead:
 * every `drizzle/<tag>.sql` gets a hand-written `drizzle/<tag>.down.sql`
 * sibling (see the two files landed with this change), and this function
 * applies them in exactly reverse order, most-recently-applied first.
 *
 * It stays in step with `drizzle-orm/node-postgres/migrator`'s own
 * bookkeeping instead of keeping a second ledger: that migrator tracks what
 * it has applied in `drizzle.__drizzle_migrations(id, hash, created_at)`,
 * where `hash` is `sha256(<the up file's raw content>)` (see
 * `drizzle-orm/migrator.js`'s `readMigrationFiles`). This function computes
 * the same hash for every entry in `meta/_journal.json`, matches it against
 * that table to find what is *actually* applied (not just what the journal
 * lists), runs the matching `.down.sql` inside a transaction, and deletes
 * that row — so a subsequent `migrate()` call sees exactly the same
 * evidence it would after a fresh, un-migrated database and is willing to
 * re-run the "up" migration.
 */

interface JournalEntry {
  tag: string
}

interface Journal {
  entries: JournalEntry[]
}

interface AppliedMigration {
  hash: string
  createdAt: string
}

function readJournal(migrationsFolder: string): JournalEntry[] {
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal
  return journal.entries
}

function hashOf(migrationsFolder: string, tag: string): string {
  const sql = readFileSync(path.join(migrationsFolder, `${tag}.sql`), 'utf8')
  return createHash('sha256').update(sql).digest('hex')
}

async function readAppliedMigrations(pool: Pool): Promise<AppliedMigration[]> {
  const exists = await pool.query<{ exists: boolean }>(
    `select exists (
       select 1 from information_schema.tables
       where table_schema = 'drizzle' and table_name = '__drizzle_migrations'
     ) as exists`,
  )
  if (exists.rows[0]?.exists !== true) return []

  const result = await pool.query<{ hash: string; created_at: string }>(
    `select hash, created_at from drizzle.__drizzle_migrations order by created_at desc`,
  )
  return result.rows.map((row) => ({ hash: row.hash, createdAt: row.created_at }))
}

export interface MigrateDownOptions {
  migrationsFolder: string
  /** How many applied migrations to roll back, most recent first. Defaults to all of them. */
  steps?: number
}

/** Rolls back applied migrations by running their `.down.sql` siblings. Returns how many were rolled back. */
export async function migrateDown(pool: Pool, { migrationsFolder, steps }: MigrateDownOptions): Promise<number> {
  const journalEntries = readJournal(migrationsFolder)
  const byHash = new Map(journalEntries.map((entry) => [hashOf(migrationsFolder, entry.tag), entry.tag]))

  const applied = await readAppliedMigrations(pool)
  const toRollBack = applied.slice(0, steps ?? applied.length)

  let rolledBack = 0
  for (const migration of toRollBack) {
    const tag = byHash.get(migration.hash)
    if (tag === undefined) {
      throw new Error(
        `migrateDown: applied migration with hash ${migration.hash} matches no file in ${migrationsFolder} — the journal and the database have drifted apart.`,
      )
    }

    const downPath = path.join(migrationsFolder, `${tag}.down.sql`)
    const downSql = readFileSync(downPath, 'utf8')

    const client = await pool.connect()
    try {
      await client.query('begin')
      for (const statement of downSql.split('--> statement-breakpoint')) {
        const trimmed = statement.trim()
        if (trimmed.length === 0) continue
        await client.query(trimmed)
      }
      await client.query('delete from drizzle.__drizzle_migrations where hash = $1', [migration.hash])
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
    rolledBack += 1
  }

  return rolledBack
}
