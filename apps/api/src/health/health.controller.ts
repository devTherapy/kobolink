import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common'
import { DbService } from '../db/db.service.js'

interface HealthResponse {
  status: 'ok'
}

/**
 * `GET /api/health` (the global prefix set in `main.ts` supplies `/api`;
 * this must stay in sync with `API.health` from `@kobolink/contracts`, which
 * `health.controller.spec.ts` reads off this controller's own route
 * metadata rather than hardcoding the path a second time).
 *
 * Round-trips Postgres before answering, so a 200 means the database is
 * actually reachable — not just that the process is up. A database that is
 * down is an expected, monitorable condition, not a bug: it is logged at
 * `warn` (not `error` with a driver stack trace) and answered as a
 * conventional 503, which is what an orchestrator's liveness/readiness probe
 * expects to see.
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name)

  constructor(private readonly db: DbService) {}

  @Get()
  async check(): Promise<HealthResponse> {
    try {
      await this.db.ping()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn(`database ping failed: ${message}`)
      throw new ServiceUnavailableException('Database unavailable.')
    }
    return { status: 'ok' }
  }
}
