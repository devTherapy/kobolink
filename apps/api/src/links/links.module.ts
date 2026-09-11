import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { defaultLinkCodeGenerator, LINK_CODE_GENERATOR } from './link-code.generator.js'
import { LinksController } from './links.controller.js'
import { LinksService } from './links.service.js'

/**
 * Imports `AuthModule` for `SessionGuard`/`MerchantGuard` (it exports both,
 * per its own doc comment — every merchant-only module from B3 onward does
 * this instead of redeclaring guard instances). `LINK_CODE_GENERATOR` is
 * registered here, not inlined in `LinksService`'s constructor, so a test
 * can override just this one provider (`Test.createTestingModule(...)
 * .overrideProvider(LINK_CODE_GENERATOR)`) without touching anything else
 * the module wires up — the collision-retry integration test's seam.
 */
@Module({
  imports: [AuthModule],
  controllers: [LinksController],
  providers: [LinksService, { provide: LINK_CODE_GENERATOR, useValue: defaultLinkCodeGenerator }],
})
export class LinksModule {}
