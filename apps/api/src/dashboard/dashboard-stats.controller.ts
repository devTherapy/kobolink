import { Controller, Get, UseGuards } from '@nestjs/common'
import type { DashboardStats, User } from '@kobolink/contracts'
import { CurrentUser } from '../auth/current-user.decorator.js'
import { MerchantGuard } from '../auth/merchant.guard.js'
import { SessionGuard } from '../auth/session.guard.js'
import { DashboardStatsService } from './dashboard-stats.service.js'

/**
 * `GET /api/dashboard/stats` (`API.dashboard.stats`) — PLAN.md's B9 row.
 * `@UseGuards(SessionGuard, MerchantGuard)`, same composition as
 * `LinksController`: no credential is `unauthenticated` 401, an
 * authenticated customer is `forbidden` 403. The merchant id comes only
 * from the session (`@CurrentUser()`), never a query or path parameter, so
 * there is no way to ask for another merchant's numbers.
 *
 * Read-only: derived from the ledger on every call, so there is no money
 * movement here and nothing for an `Idempotency-Key` to protect — a replay
 * is simply the same read.
 */
@Controller('dashboard')
@UseGuards(SessionGuard, MerchantGuard)
export class DashboardStatsController {
  constructor(private readonly statsService: DashboardStatsService) {}

  @Get('stats')
  async stats(@CurrentUser() user: User): Promise<DashboardStats> {
    return this.statsService.statsFor(user.id)
  }
}
