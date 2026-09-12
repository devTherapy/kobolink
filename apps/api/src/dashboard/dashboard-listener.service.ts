import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { type DashboardEvent } from '@kobolink/contracts'
import { eq } from 'drizzle-orm'
import { Client, type Notification } from 'pg'
import { DbService } from '../db/db.service.js'
import * as schema from '../db/schema/index.js'
import { PostingLinkPaymentMetadataSchema, rowToPayment } from '../payments/payment-mapper.js'
import { computeDashboardStats } from './dashboard-stats.js'
import { parseDashboardNotification } from './dashboard-notification.js'
import { DashboardStreamService } from './dashboard-stream.service.js'

/** `drizzle/0005_postings_notify_dashboard.sql`'s `pg_notify` channel. */
const CHANNEL = 'dashboard_events'
/** Backoff between a dropped LISTEN connection and the next reconnect attempt. */
const RECONNECT_DELAY_MS = 1_000

/**
 * PLAN.md's B6 row — the "fed by Postgres LISTEN/NOTIFY" half.
 *
 * Owns exactly one dedicated `pg.Client` per process, entirely separate
 * from `DbService`'s pool (that file's own doc comment: pooled connections
 * run ordinary queries and get handed back; a connection sitting in
 * `LISTEN` must never be one of them, or a `LISTEN` could be silently
 * dropped by a query running on what the pool thinks is a free
 * connection, or a query could hang behind a connection this service never
 * intends to release). `onModuleInit`/`onModuleDestroy` bound its
 * lifetime to the Nest application's own, the same pattern `DbService`
 * uses for the pool and `RateLimiterService` uses for its sweep interval.
 *
 * Every notification re-reads the full posting (and its link) from the
 * pooled connection (`DbService.db`, an ordinary query) rather than trusting
 * anything beyond `{table, id}` carried on the wire — see
 * `0005_postings_notify_dashboard.sql`'s own doc comment for why the
 * payload is minimal and why that re-read is where a `DashboardEvent`
 * actually gets built (stats, `resolveLink`, masking — all TypeScript,
 * all already tested elsewhere, never duplicated into PL/pgSQL).
 *
 * Only `kind: 'link_payment'` postings produce an event today —
 * `payment.completed`/`payment.failed`. `link.created`/`link.updated`
 * (also part of `DashboardEventSchema`) are not wired to anything yet; no
 * trigger fires for them and nothing in `LinksService` calls this service.
 * That is deliberately out of scope for this PR — see the PR description's
 * "what is deliberately not done yet".
 */
@Injectable()
export class DashboardListenerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DashboardListenerService.name)
  private client: Client | undefined
  private stopped = false

  constructor(
    private readonly config: ConfigService,
    private readonly db: DbService,
    private readonly stream: DashboardStreamService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.connect()
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true
    await this.disconnect()
  }

  private async connect(): Promise<void> {
    const client = new Client({ connectionString: this.config.getOrThrow<string>('DATABASE_URL') })

    client.on('notification', (message: Notification) => {
      if (message.channel !== CHANNEL) return
      void this.handleNotification(message.payload)
    })
    // A dedicated `Client` (unlike `DbService`'s `Pool`) has no built-in
    // recovery from its socket erroring or closing — `error` alone would
    // otherwise be an uncaught event that crashes the process (same
    // reasoning as `DbService`'s own `pool.on('error', ...)`), and `end`
    // is Postgres's own signal that the connection is gone even without an
    // `error` event ever firing (e.g. the server closing an idle
    // connection). Both funnel into the same reconnect loop.
    client.on('error', (error: Error) => {
      this.logger.error(`dashboard LISTEN connection error: ${error.message}`, error.stack)
    })
    client.on('end', () => {
      if (this.stopped) return
      this.logger.warn('dashboard LISTEN connection closed unexpectedly — reconnecting')
      void this.reconnectLoop()
    })

    await client.connect()
    await client.query(`LISTEN ${CHANNEL}`)
    this.client = client
  }

  private async disconnect(): Promise<void> {
    const client = this.client
    if (client === undefined) return
    this.client = undefined
    client.removeAllListeners()
    try {
      await client.end()
    } catch (error) {
      this.logger.warn(`dashboard LISTEN connection: error while closing: ${String(error)}`)
    }
  }

  private async reconnectLoop(): Promise<void> {
    await this.disconnect()
    while (!this.stopped) {
      await new Promise<void>((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS))
      if (this.stopped) return
      try {
        await this.connect()
        return
      } catch (error) {
        this.logger.error(`dashboard LISTEN reconnect attempt failed: ${String(error)}`)
      }
    }
  }

  private async handleNotification(payload: string | undefined): Promise<void> {
    const notification = parseDashboardNotification(payload)
    if (notification === undefined) {
      this.logger.warn(`dashboard notification: unparseable payload: ${String(payload)}`)
      return
    }
    // Only 'postings' is ever produced today (0005's trigger); an
    // unrecognised table name is ignored rather than treated as an error,
    // so a future trigger on another table can share this channel without
    // this listener needing to change in lockstep.
    if (notification.table !== 'postings') return

    try {
      await this.handlePosting(notification.id)
    } catch (error) {
      this.logger.error(
        `dashboard notification: failed to process posting ${notification.id}: ${String(error)}`,
        error instanceof Error ? error.stack : undefined,
      )
    }
  }

  private async handlePosting(postingId: string): Promise<void> {
    const [row] = await this.db.db.select().from(schema.postings).where(eq(schema.postings.id, postingId)).limit(1)
    // The trigger only fires after a committed INSERT, so the row always
    // exists by the time this runs — this is a defensive guard against a
    // schema/migration drift, not an expected path.
    if (row === undefined) return
    // B8 will insert `transfer`/`topup` postings through this same trigger
    // (drizzle/0005's own doc comment); neither has a `DashboardEvent`
    // variant yet, so this listener has nothing to do with them today.
    if (row.kind !== 'link_payment') return

    const metadata = PostingLinkPaymentMetadataSchema.parse(row.metadata)
    const [linkRow] = await this.db.db
      .select({ merchantUserId: schema.links.merchantUserId })
      .from(schema.links)
      .where(eq(schema.links.code, metadata.linkCode))
      .limit(1)
    // A link_payment posting always names a link that still exists —
    // `links` rows are never deleted. Defensive, not a normal path.
    if (linkRow === undefined) return

    const payment = rowToPayment(row)
    const event: DashboardEvent =
      metadata.status === 'success'
        ? { type: 'payment.completed', payment, stats: await computeDashboardStats(this.db.db, linkRow.merchantUserId) }
        : { type: 'payment.failed', payment }

    this.stream.publish(linkRow.merchantUserId, event)
  }
}
