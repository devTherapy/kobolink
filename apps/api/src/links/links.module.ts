import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { defaultLinkCodeGenerator, LINK_CODE_GENERATOR } from './link-code.generator.js'
import { LinksController } from './links.controller.js'
import { LinksService } from './links.service.js'
import { PublicLinksController } from './public-links.controller.js'

/**
 * Imports `AuthModule` for `SessionGuard`/`MerchantGuard` (it exports both,
 * per its own doc comment — every merchant-only module from B3 onward does
 * this instead of redeclaring guard instances). `LINK_CODE_GENERATOR` is
 * registered here, not inlined in `LinksService`'s constructor, so a test
 * can override just this one provider (`Test.createTestingModule(...)
 * .overrideProvider(LINK_CODE_GENERATOR)`) without touching anything else
 * the module wires up — the collision-retry integration test's seam.
 *
 * `PublicLinksController` (B4) is a second controller in this same module,
 * not a method on `LinksController` — see its own doc comment for why. It
 * shares `LinksService` with the merchant-facing controller but composes no
 * guard of its own, so importing `AuthModule` here never puts `SessionGuard`
 * in its path.
 *
 * `LinksService` is exported (B5) so `PaymentsModule` can import this module
 * and call `getForCheckout` from inside its own posting transaction — see
 * that method's doc comment on `LinksService`.
 */
@Module({
  imports: [AuthModule],
  controllers: [LinksController, PublicLinksController],
  providers: [LinksService, { provide: LINK_CODE_GENERATOR, useValue: defaultLinkCodeGenerator }],
  exports: [LinksService],
})
export class LinksModule {}
