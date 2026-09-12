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
 * How long a single connect attempt may hang before `pg` gives up. Without
 * this, a blackholed host (as opposed to a fast `ECONNREFUSED`) during a
 * reconnect could leave `client.connect()` pending forever, wedging the
 * whole reconnect loop.
 */
const CONNECT_TIMEOUT_MS = 5_000
/**
 * Tags every dedicated LISTEN connection in `pg_stat_activity` — lets an
 * operator (or an integration test that needs to force a real Postgres-level
 * disconnect on *this* connection specifically, as opposed to any other
 * backend) find its PID without guessing. Exported so
 * `dashboard-listener-reconnect.integration.test.ts` can filter
 * `pg_stat_activity` by the exact same value instead of duplicating the
 * string literal.
 */
export const DASHBOARD_LISTENER_APPLICATION_NAME = 'kobolink_dashboard_listener'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
 *
 * ## Reconnect concurrency
 *
 * `pg`'s `Connection` emits `end` on *every* underlying stream close,
 * including one that happens mid-way through a *failed* `connect()` call
 * (the socket the driver just opened gets torn down, and `end` fires for
 * it on the next tick — this is true even though `client.connect()` itself
 * also rejects around the same time). Because the `end` listener is
 * attached before `await client.connect()` resolves, it is already
 * listening when that happens. A naive "`end` → `reconnectLoop()`"
 * handler therefore spawns one independent reconnect loop *per failed
 * attempt*, on top of whatever loop is already retrying — during an outage
 * longer than a couple of retry cycles this grows unboundedly, and every
 * one of those loops eventually succeeds independently, each assigning
 * itself as `this.client` (last writer wins) while every earlier one is
 * simply orphaned, still alive, its `notification` handler still attached
 * — so every later payment gets delivered once per leaked client.
 *
 * The guard against this: `this.client` names the one client this service
 * currently considers "live" (fully connected *and* past `LISTEN`). Every
 * client's `end` handler checks `this.client === client` (the exact
 * instance captured in its own closure) before doing anything. A client
 * that is still mid-`connect()` — the common case above — is never
 * `this.client` yet, so its spurious `end` is a pure no-op: the failure is
 * instead handled exactly once, by `reconnectLoop`'s own `try/catch`
 * around `connect()`. `reconnectLoop` itself is additionally guarded by
 * `reconnecting` so that even a client which *was* live (a real drop) can
 * only ever kick off one concurrent loop.
 *
 * `stopped` is checked again immediately after a connect attempt resolves
 * (both `client.connect()` and the subsequent `LISTEN`), before ever
 * assigning `this.client` — closing the race where `onModuleDestroy` runs
 * while a connect is in flight: the completing attempt sees `stopped` and
 * closes the client it just built instead of adopting it, so nothing can
 * outlive teardown.
 */
@Injectable()
export class DashboardListenerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DashboardListenerService.name)
  /** The one client this service currently considers live (connected *and* past `LISTEN`). */
  private client: Client | undefined
  /** The `notification`/`end` handlers attached to `this.client`, so graceful shutdown can detach exactly those two (never `error`) before closing it. */
  private liveHandlers: { notification: (message: Notification) => void; end: () => void } | undefined
  private stopped = false
  /** Single-flight guard: at most one `reconnectLoop` body actually runs at a time. */
  private reconnecting = false

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
    const client = new Client({
      connectionString: this.config.getOrThrow<string>('DATABASE_URL'),
      application_name: DASHBOARD_LISTENER_APPLICATION_NAME,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    })

    const onNotification = (message: Notification): void => {
      // Only this client's own status as `this.client` makes its
      // notifications count — a superseded client's listener may still
      // technically be attached for a brief window and must not double
      // deliver alongside whichever client actually replaced it.
      if (this.client !== client) return
      if (message.channel !== CHANNEL) return
      void this.handleNotification(message.payload)
    }
    // A dedicated `Client` (unlike `DbService`'s `Pool`) has no built-in
    // recovery from its socket erroring or closing — `error` alone would
    // otherwise be an uncaught event that crashes the process (same
    // reasoning as `DbService`'s own `pool.on('error', ...)`), and `end`
    // is Postgres's own signal that the connection is gone even without an
    // `error` event ever firing (e.g. the server closing an idle
    // connection). Both funnel into the same reconnect loop — but only
    // for the client this service still recognises as live; see the class
    // doc comment for why that guard exists.
    const onError = (error: Error): void => {
      this.logger.error(`dashboard LISTEN connection error: ${error.message}`, error.stack)
    }
    const onEnd = (): void => {
      if (this.client !== client) return // stale/superseded attempt tearing itself down — not a signal to reconnect
      this.client = undefined
      this.liveHandlers = undefined
      this.logger.warn('dashboard LISTEN connection closed unexpectedly — reconnecting')
      void this.reconnectLoop()
    }

    client.on('notification', onNotification)
    client.on('error', onError)
    client.on('end', onEnd)

    await client.connect()
    try {
      await client.query(`LISTEN ${CHANNEL}`)
    } catch (error) {
      // Connected but never got to LISTEN — this client will never be
      // `this.client` and its `end`/`error` handlers above already no-op
      // for a client that isn't, so nothing else will ever close it.
      await this.forceEnd(client)
      throw error
    }

    if (this.stopped) {
      // onModuleDestroy ran while this connect attempt was in flight —
      // close what we just opened instead of adopting it as live, or it
      // would outlive teardown with nothing left to stop it.
      await this.forceEnd(client)
      return
    }

    this.client = client
    this.liveHandlers = { notification: onNotification, end: onEnd }
  }

  /** Closes a client this service is discarding (never assigned as `this.client`) — a failed post-connect step, or one superseded by shutdown while connecting. */
  private async forceEnd(client: Client): Promise<void> {
    // A temporary no-op `error` handler so a benign socket error during
    // this close can never surface as an uncaught 'error' event — this
    // client was never live, so there is nothing further for a real
    // handler to usefully report.
    client.on('error', () => undefined)
    try {
      await client.end()
    } catch (error) {
      this.logger.warn(`dashboard LISTEN connection: error while closing a discarded client: ${String(error)}`)
    }
  }

  private async disconnect(): Promise<void> {
    const client = this.client
    if (client === undefined) return
    this.client = undefined
    // Detach only the `notification`/`end` handlers this service attached
    // — never `error` — so a rare non-fatal socket error while `end()` is
    // in flight still has a listener and can't become an uncaught
    // exception (the exact crash `error`'s own handler exists to prevent).
    if (this.liveHandlers !== undefined) {
      client.off('notification', this.liveHandlers.notification)
      client.off('end', this.liveHandlers.end)
      this.liveHandlers = undefined
    }
    try {
      await client.end()
    } catch (error) {
      this.logger.warn(`dashboard LISTEN connection: error while closing: ${String(error)}`)
    }
  }

  private async reconnectLoop(): Promise<void> {
    if (this.reconnecting) return // a loop is already retrying; this call is redundant, not a second attempt
    this.reconnecting = true
    try {
      await this.disconnect()
      while (!this.stopped) {
        await sleep(RECONNECT_DELAY_MS)
        if (this.stopped) return
        try {
          await this.connect()
          return
        } catch (error) {
          this.logger.error(`dashboard LISTEN reconnect attempt failed: ${String(error)}`)
        }
      }
    } finally {
      this.reconnecting = false
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
