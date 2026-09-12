import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { ExtractTablesWithRelations } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase, type NodePgTransaction } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema/index.js'

export type Database = NodePgDatabase<typeof schema>

/** What `Database['transaction']` hands its callback — same query surface as `Database`, scoped to one transaction. */
export type DbTransaction = NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>

/**
 * Anything that can run a Drizzle query: the pooled `Database` for a plain
 * read, or a `DbTransaction` for a step that must share a transaction with
 * other writes (B5's `PaymentsService` is the first caller that needs this —
 * a posting and its ledger entries, or a `checkout_sessions` claim, must all
 * run against the same transaction, not a fresh pooled connection).
 */
export type Executor = Database | DbTransaction

/**
 * Owns the Postgres pool and the Drizzle client built on top of it. One
 * instance per Nest application — `DbModule` is `@Global`, so every feature
 * module injects this instead of opening its own pool.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly logger = new Logger(DbService.name)
  private readonly pool: Pool
  readonly db: Database

  constructor(config: ConfigService) {
    this.pool = new Pool({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
      // Fail fast against a blackholed host instead of hanging the request
      // (and the process) indefinitely.
      connectionTimeoutMillis: 5_000,
      // Applied server-side to every query on connections from this pool.
      statement_timeout: 5_000,
      // Client-side backstop for the case the server itself never answers.
      query_timeout: 5_000,
    })
    // A pooled client's socket can error while idle (a Postgres restart, a
    // failover, an idle-connection reset). `pg` re-emits that on the pool;
    // with no listener it is an uncaught error that crashes the process.
    this.pool.on('error', (error: Error) => {
      this.logger.error(`idle client error: ${error.message}`, error.stack)
    })
    this.db = drizzle(this.pool, { schema })
  }

  /** Round-trips a real query through the real driver. Throws if the database is unreachable. */
  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`)
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('closing the Postgres pool')
    await this.pool.end()
  }
}
