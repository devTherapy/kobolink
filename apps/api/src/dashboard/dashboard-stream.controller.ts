import { Controller, Get, Logger, Req, Res, UseGuards } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Request, Response } from 'express'
import { SSE_HEARTBEAT_MS, type DashboardEvent, type User } from '@kobolink/contracts'
import { AuthService, type ResolvedSession } from '../auth/auth.service.js'
import { CurrentUser } from '../auth/current-user.decorator.js'
import { extractToken } from '../auth/extract-token.js'
import { MerchantGuard } from '../auth/merchant.guard.js'
import { SessionGuard } from '../auth/session.guard.js'
import { formatSseFrame } from './sse-frame.js'
import { DashboardStreamService } from './dashboard-stream.service.js'

/**
 * `GET /api/stream/dashboard` (`API.dashboard.stream`) — PLAN.md's B6 row.
 * `@UseGuards(SessionGuard, MerchantGuard)`, same composition as
 * `LinksController` (that class's own doc comment): a missing/invalid
 * credential is `unauthenticated` before this handler ever runs, an
 * authenticated customer is `forbidden`, and — because both guards run
 * and throw *before* any byte of this response is written — the ordinary
 * `HttpExceptionFilter` handles both cases exactly like any other route.
 * Once this handler starts writing (`res.flushHeaders()` below), that
 * filter's own doc comment already accounts for it: `headersSent` on a
 * later, unrelated error means it only logs, never tries to rewrite a
 * response already in flight.
 *
 * **What "a dropped connection reconnects" means here.** A browser
 * `EventSource` reconnects on its own after a drop and resends whatever
 * `Last-Event-ID` it last saw. This PR reads that header for nothing —
 * there is no store of past events to replay it against — but every frame
 * still carries `id:` (`formatSseFrame`), so the wire protocol is already
 * correct for a future PR that adds one. What this PR *does* guarantee: a
 * client that disconnects and reconnects gets a brand-new subscription
 * with no trace of the old one left behind — `req.on('close', ...)`
 * always unsubscribes from `DashboardStreamService` and clears the
 * heartbeat timer, proven by not leaking a listener across many
 * connect/disconnect cycles
 * (`dashboard-stream-lifecycle.integration.test.ts`), never by assuming
 * the client will behave.
 *
 * **Heartbeat.** `DASHBOARD_HEARTBEAT_MS` (env, default
 * `SSE_HEARTBEAT_MS` — `packages/contracts`' own recommendation of 15s,
 * "proxies commonly cut idle streams at 30-60s") is a real, contract-
 * shaped `{type: 'heartbeat', at}` event, not a bare `:` comment — the
 * contract already defines `heartbeat` as one of `DashboardEvent`'s
 * variants specifically so a client validates every event frame it
 * receives against one schema, this one included, rather than treating
 * heartbeats as a special case.
 *
 * **Opening comment.** The one exception to "every frame is an event" is
 * the `: open` comment line written right after the headers (see
 * `dashboard()`), so a piping proxy forwards the response head at once.
 * Every SSE parser ignores it; a hand-written Swift/Kotlin parser must
 * skip comment lines (lines starting with `:`) too.
 *
 * **The session is re-checked for the life of the stream.** The guards run
 * once, at connect; a session revoked afterwards (logout in another tab, an
 * admin revoke) or expired would otherwise keep receiving the merchant's
 * payment events until the connection happened to drop. So every frame this
 * connection writes -- each event and each heartbeat -- first passes
 * `sessionStillValid` (the same `AuthService.resolveSession` lookup
 * `SessionGuard` uses; the stored expiry is also checked in memory first,
 * so an expired session never costs a query). The first failed check ends
 * the response and releases the listener and the timer, exactly as a client
 * disconnect does; the client sees a clean end of stream, reconnects, is
 * refused with `unauthenticated` by the guard, and shows "signed out". A
 * failed lookup (database error) ends the stream too: this fails closed,
 * because the cost of a spurious reconnect is nothing next to the cost of
 * delivering to a credential that may be revoked. The per-event check is one
 * indexed read per open stream per payment event -- negligible at payment
 * rates -- and checks run through a per-connection queue so frames can never
 * be reordered by a slow lookup.
 */
@Controller('stream')
@UseGuards(SessionGuard, MerchantGuard)
export class DashboardStreamController {
  private readonly logger = new Logger(DashboardStreamController.name)

  constructor(
    private readonly stream: DashboardStreamService,
    private readonly config: ConfigService,
    private readonly authService: AuthService,
  ) {}

  @Get('dashboard')
  dashboard(@CurrentUser() user: User, @Req() req: Request, @Res() res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    // Nginx (a common reverse proxy in front of a Node API) buffers a
    // proxied response by default, which defeats an SSE stream entirely —
    // nothing reaches the client until the buffer fills or the connection
    // closes. This header is nginx-specific and harmless everywhere else.
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    // Start the body at once. A proxy that pipes this response (Next's
    // `/api/*` rewrite) forwards the head only with the first body bytes, so
    // without this the browser's `EventSource` never fires `open` -- and the
    // dashboard sits on "Connecting..." -- until the first heartbeat, a full
    // `SSE_HEARTBEAT_MS` later. A comment line is ignored by every SSE parser.
    res.write(': open\n\n')

    const auth = req.auth
    const token = extractToken({
      cookies: req.cookies as Record<string, string | undefined> | undefined,
      authorizationHeader: req.headers.authorization,
    })

    let cleanedUp = false
    // Frames are written strictly in the order they were handed in, one
    // session check at a time, so a slow lookup cannot reorder or interleave.
    let queue: Promise<void> = Promise.resolve()
    let pendingChecks = 0

    const end = (): void => {
      if (cleanedUp) return
      cleanup()
      res.end()
    }

    const write = (id: number, event: DashboardEvent): void => {
      pendingChecks += 1
      queue = queue
        .then(async () => {
          if (cleanedUp) return
          if (!(await this.sessionStillValid(auth, token))) {
            end()
            return
          }
          // The connection may have closed while the lookup was in flight.
          if (cleanedUp) return
          res.write(formatSseFrame(id, event))
        })
        .catch((error: unknown) => {
          this.logger.warn(`dashboard stream: write failed: ${error instanceof Error ? error.message : String(error)}`)
          end()
        })
        .finally(() => {
          pendingChecks -= 1
        })
    }

    const unsubscribe = this.stream.subscribe(user.id, (message) => write(message.id, message.event))

    const heartbeatMs = this.heartbeatIntervalMs()
    const heartbeat = setInterval(() => {
      // A frame already waiting on its session check will revalidate anyway;
      // do not stack heartbeats behind a stalled database.
      if (pendingChecks > 0) return
      write(this.stream.nextId(), { type: 'heartbeat', at: new Date().toISOString() })
    }, heartbeatMs)
    // Never keeps the process alive on its own — see RateLimiterService's
    // sweep interval for the same reasoning.
    heartbeat.unref()

    const cleanup = (): void => {
      if (cleanedUp) return
      cleanedUp = true
      clearInterval(heartbeat)
      unsubscribe()
    }

    // 'close' fires for every way this connection ends — the client
    // disconnecting, the server ending the response, a network drop — so
    // it alone is enough to guarantee cleanup always runs exactly once.
    req.on('close', cleanup)
    res.on('error', (error: Error) => {
      this.logger.warn(`dashboard stream: response error: ${error.message}`)
      cleanup()
    })
  }

  /**
   * True while the session this stream was opened with still resolves to the
   * same session and a merchant user. Never throws: an error is logged and
   * counts as "not valid" (fail closed -- see the class doc comment).
   */
  private async sessionStillValid(auth: ResolvedSession | undefined, token: string | undefined): Promise<boolean> {
    if (auth === undefined || token === undefined) return false
    // Expiry is known without a query.
    if (auth.session.expiresAt.getTime() <= Date.now()) return false
    try {
      const resolved = await this.authService.resolveSession(token)
      return resolved?.session.id === auth.session.id &&resolved.user.role === 'merchant'
    } catch (error) {
      this.logger.warn(`dashboard stream: session re-check failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  private heartbeatIntervalMs(): number {
    const configured = this.config.get<string>('DASHBOARD_HEARTBEAT_MS')
    if (configured === undefined) return SSE_HEARTBEAT_MS
    const parsed = Number(configured)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : SSE_HEARTBEAT_MS
  }
}
