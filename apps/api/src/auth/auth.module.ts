import { Module } from '@nestjs/common'
import { AuthController } from './auth.controller.js'
import { AuthService } from './auth.service.js'
import { MerchantGuard } from './merchant.guard.js'
import { RateLimiterService } from './rate-limiter.service.js'
import { SessionGuard } from './session.guard.js'

/**
 * `SessionGuard` and `MerchantGuard` are exported (not just `AuthService`) so
 * every later feature module (B3's links, B5's payments, ...) can
 * `@UseGuards(SessionGuard)` / `@UseGuards(SessionGuard, MerchantGuard)` by
 * importing `AuthModule`, instead of each redeclaring its own guard
 * instance.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService, RateLimiterService, SessionGuard, MerchantGuard],
  exports: [AuthService, SessionGuard, MerchantGuard],
})
export class AuthModule {}
