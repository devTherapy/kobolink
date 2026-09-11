import { Controller, Get } from '@nestjs/common'
import { DbService } from '../db/db.service.js'

interface HealthResponse {
  status: 'ok'
}

/**
 * `GET /api/health` (the global prefix set in `main.ts` supplies `/api`;
 * this must stay in sync with `API.health` from `@kobolink/contracts`, which
 * `health.controller.spec.ts` and the boot integration test both assert
 * against directly rather than hardcoding the path a second time).
 *
 * Round-trips Postgres before answering, so a 200 means the database is
 * actually reachable — not just that the process is up.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Get()
  async check(): Promise<HealthResponse> {
    await this.db.ping()
    return { status: 'ok' }
  }
}
