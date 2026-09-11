import { Module } from '@nestjs/common'
import { IdempotencyService } from '../common/idempotency/idempotency.service.js'
import { LinksModule } from '../links/links.module.js'
import { defaultPaymentReferenceGenerator, PAYMENT_REFERENCE_GENERATOR } from './payment-reference.generator.js'
import { PaymentsController } from './payments.controller.js'
import { PaymentsService } from './payments.service.js'

/**
 * PLAN.md's B5 row. Imports `LinksModule` for its exported `LinksService`
 * (`getForCheckout`) — never `AuthModule`: `PaymentsController` carries no
 * guard, on purpose, same as `PublicLinksController`.
 *
 * `PAYMENT_REFERENCE_GENERATOR` is bound to the real generator here so a
 * test can override just this one provider (`.overrideProvider(
 * PAYMENT_REFERENCE_GENERATOR)`) without touching anything else — see
 * `payment-reference.generator.ts`.
 */
@Module({
  imports: [LinksModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    IdempotencyService,
    { provide: PAYMENT_REFERENCE_GENERATOR, useValue: defaultPaymentReferenceGenerator },
  ],
})
export class PaymentsModule {}
