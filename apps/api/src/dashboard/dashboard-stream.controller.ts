import { Controller, Get, Logger, Req, Res, UseGuards } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Request, Response } from 'express'
import { SSE_HEARTBEAT_MS, type DashboardEvent, type User } from '@kobolink/contracts'
import { CurrentUser } from '../auth/current-user.decorator.js'
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
 * variants specifically so a client validates every message it receives
 * against one schema, this one included, rather than treating heartbeats
 * as a special case its parser has to know about.
 */
@Controller('stream')
@UseGuards(SessionGuard, MerchantGuard)
export class DashboardStreamController {
  private readonly logger = new Logger(DashboardStreamController.name)

  constructor(
    private readonly stream: DashboardStreamService,
    private readonly config: ConfigService,
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

    const write = (id: number, event: DashboardEvent): void => {
      res.write(formatSseFrame(id, event))
    }

    const unsubscribe = this.stream.subscribe(user.id, (message) => write(message.id, message.event))

    const heartbeatMs = this.heartbeatIntervalMs()
    const heartbeat = setInterval(() => {
      write(this.stream.nextId(), { type: 'heartbeat', at: new Date().toISOString() })
    }, heartbeatMs)
    // Never keeps the process alive on its own — see RateLimiterService's
    // sweep interval for the same reasoning.
    heartbeat.unref()

    let cleanedUp = false
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

  private heartbeatIntervalMs(): number {
    const configured = this.config.get<string>('DASHBOARD_HEARTBEAT_MS')
    if (configured === undefined) return SSE_HEARTBEAT_MS
    const parsed = Number(configured)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : SSE_HEARTBEAT_MS
  }
}
