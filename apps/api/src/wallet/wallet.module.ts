import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { IdempotencyService } from '../common/idempotency/idempotency.service.js'
import { defaultWalletReferenceGenerator, WALLET_REFERENCE_GENERATOR } from './wallet-reference.generator.js'
import { WalletController } from './wallet.controller.js'
import { WalletService } from './wallet.service.js'

/**
 * PLAN.md's B8 row. Imports `AuthModule` for `SessionGuard` only — never
 * `MerchantGuard`, see `WalletController`'s own doc comment. `DbService`
 * needs no import here: `DbModule` is `@Global()`.
 *
 * `WALLET_REFERENCE_GENERATOR` is bound to the real generator here, the
 * same DI seam `PaymentsModule` gives `PAYMENT_REFERENCE_GENERATOR` — a
 * test overrides just this one provider to force a genuine
 * `postings_reference_unique` collision.
 */
@Module({
  imports: [AuthModule],
  controllers: [WalletController],
  providers: [
    WalletService,
    IdempotencyService,
    { provide: WALLET_REFERENCE_GENERATOR, useValue: defaultWalletReferenceGenerator },
  ],
})
export class WalletModule {}
