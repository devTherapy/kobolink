import { Controller, type DynamicModule, Get, Module, Post, UseGuards, forwardRef } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { MerchantGuard } from '../auth/merchant.guard.js'
import { SessionGuard } from '../auth/session.guard.js'
import { mountedControllers, mountedRoutes } from './mounted-routes.js'

/**
 * `route-manifest.spec.ts` proves these two functions against the real
 * `AppModule`; this file proves the edges that module happens not to
 * exercise today, with throwaway controllers and modules built from the
 * same Nest decorators, so the rules hold before the first real module
 * needs them.
 */

@Controller('open')
class OpenController {
  @Get() list(): void { /* no-op */ }
}

@Controller('mixed')
@UseGuards(SessionGuard)
class MixedController {
  @Get() me(): void { /* no-op */ }
  @Post('admin') @UseGuards(MerchantGuard) admin(): void { /* no-op */ }
}

@Controller('misordered')
@UseGuards(MerchantGuard, SessionGuard)
class MisorderedController {
  @Get() broken(): void { /* no-op */ }
}

class SomeOtherGuard {}

@Controller('exotic')
@UseGuards(SessionGuard, SomeOtherGuard)
class ExoticController {
  @Get() unknown(): void { /* no-op */ }
}

describe('mountedRoutes: auth from real @UseGuards metadata', () => {
  it('combines class-level and method-level guards, in that order', () => {
    const routes = mountedRoutes([OpenController, MixedController])
    expect(routes).toEqual([
      { method: 'get', path: '/api/open', auth: 'none' },
      { method: 'get', path: '/api/mixed', auth: 'session' },
      { method: 'post', path: '/api/mixed/admin', auth: 'merchant' },
    ])
  })

  it('refuses MerchantGuard ahead of SessionGuard — a route that 401s everyone is not a merchant route', () => {
    expect(() => mountedRoutes([MisorderedController])).toThrow(/MisorderedController\.broken .*SessionGuard ahead of it/)
  })

  it('refuses a guard it cannot classify rather than guessing an AuthMode for it', () => {
    expect(() => mountedRoutes([ExoticController])).toThrow(/ExoticController\.unknown .*SomeOtherGuard/)
  })
})

@Module({ controllers: [OpenController] })
class LeafModule {}

@Module({ imports: [LeafModule], controllers: [MixedController] })
class BranchModule {}

@Module({ imports: [forwardRef(() => BranchModule)] })
class ForwardModule {}

class DynamicHost {
  static register(): DynamicModule {
    return { module: DynamicHost, controllers: [ExoticController], imports: [LeafModule] }
  }
}

@Module({ imports: [LeafModule, ForwardModule, Promise.resolve(DynamicHost.register()), LeafModule] })
class RootModule {}

describe('mountedControllers: walks every form of `imports`', () => {
  it('reaches controllers through static, forwardRef, dynamic and Promise<dynamic> imports, each module once', async () => {
    const found = await mountedControllers(RootModule)
    // LeafModule is imported three times (twice directly, once via the
    // dynamic module) and walked once — no double-count of OpenController.
    expect(found).toEqual([OpenController, MixedController, ExoticController])
  })

  it('returns a controller twice when two different modules both mount it — Nest would, and the count check must see it', async () => {
    @Module({ controllers: [OpenController] })
    class AnotherModule {}
    @Module({ imports: [LeafModule, AnotherModule] })
    class DoubleRoot {}

    const found = await mountedControllers(DoubleRoot)
    expect(found).toEqual([OpenController, OpenController])
  })
})
