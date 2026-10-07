import { Injectable } from '@nestjs/common'
import type { DashboardStats } from '@kobolink/contracts'
import { DbService } from '../db/db.service.js'
import { computeDashboardStats } from './dashboard-stats.js'

/**
 * `GET /api/dashboard/stats` — PLAN.md's B9 row. A thin transaction wrapper
 * around `computeDashboardStats`, the same function B6's stream embeds in
 * `payment.completed`/`link.*` events, so a plain read and a pushed
 * snapshot are computed identically.
 *
 * The read runs in one `REPEATABLE READ`, read-only transaction because
 * `computeDashboardStats` issues two queries (the merchant's links, then
 * their ledger-derived stats): without a shared snapshot a payment landing
 * between them could count toward `paymentCount` for a link the first query
 * had already classified as still payable, which is exactly the
 * strip-disagrees-with-itself case the contract's doc comment warns about.
 * A read-only transaction cannot write a ledger row, which is also the
 * point: this route never posts anything.
 */
@Injectable()
export class DashboardStatsService {
  constructor(private readonly dbService: DbService) {}

  async statsFor(merchantId: string, asOf: Date = new Date()): Promise<DashboardStats> {
    return this.dbService.db.transaction((tx) => computeDashboardStats(tx, merchantId, asOf), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    })
  }
}
