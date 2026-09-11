import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common'
import { ApiErrorException } from '../common/errors/api-error.exception.js'
import type { AuthenticatedRequest } from './authenticated-request.js'

/**
 * Merchant-only routes (B3 onward: creating and managing links) compose this
 * *after* `SessionGuard` — `@UseGuards(SessionGuard, MerchantGuard)` — so it
 * only ever runs against an already-resolved `request.auth`. A customer role
 * reaching a merchant-only route is `forbidden` (403), not `unauthenticated`
 * (401): the caller is a real, authenticated user, just not allowed here —
 * the same distinction `packages/contracts`' `ErrorCode` already draws.
 */
@Injectable()
export class MerchantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const auth = request.auth
    // Defensive, not a normal path: only reachable if a route lists
    // MerchantGuard without SessionGuard ahead of it in the same @UseGuards.
    if (auth === undefined) {
      throw new ApiErrorException({ code: 'unauthenticated', message: 'Authentication required.' })
    }
    if (auth.user.role !== 'merchant') {
      throw new ApiErrorException({ code: 'forbidden', message: 'Merchant role required.' })
    }
    return true
  }
}
