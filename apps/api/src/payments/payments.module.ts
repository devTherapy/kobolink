import { Module } from '@nestjs/common'
import { IdempotencyService } from '../common/idempotency/idempotency.service.js'
import { LinksModule } from '../links/links.module.js'
import { PaymentsController } from './payments.controller.js'
import { PaymentsService } from './payments.service.js'

/**
 * PLAN.md's B5 row. Imports `LinksModule` for its exported `LinksService`
 * (`getForCheckout`) — never `AuthModule`: `PaymentsController` carries no
 * guard, on purpose, same as `PublicLinksController`.
 */
@Module({
  imports: [LinksModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, IdempotencyService],
})
export class PaymentsModule {}
