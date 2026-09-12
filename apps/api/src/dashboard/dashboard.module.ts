import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { DashboardListenerService } from './dashboard-listener.service.js'
import { DashboardStreamController } from './dashboard-stream.controller.js'
import { DashboardStreamService } from './dashboard-stream.service.js'

/**
 * PLAN.md's B6 row. Imports `AuthModule` for `SessionGuard`/`MerchantGuard`,
 * same convention as `LinksModule`/`PaymentsModule`. `DbModule` needs no
 * import — it is `@Global` (`db.module.ts`'s own doc comment) — so
 * `DashboardListenerService` injects `DbService` the same way every other
 * feature service does, for the ordinary pooled re-reads it does on every
 * notification; its own dedicated `LISTEN` connection is a plain `pg.Client`
 * it opens itself, deliberately outside that pool (see its own doc
 * comment).
 *
 * `DashboardStreamService` and `DashboardListenerService` are not
 * exported: nothing outside this module needs the live stream today (B8's
 * wallet postings will get a `DashboardEvent` variant of their own before
 * anything needs to reach into this module for it — tracked as future
 * work, not a reason to export early).
 */
@Module({
  imports: [AuthModule],
  controllers: [DashboardStreamController],
  providers: [DashboardStreamService, DashboardListenerService],
})
export class DashboardModule {}
