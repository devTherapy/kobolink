import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common'
import { ApiErrorException } from '../common/errors/api-error.exception.js'
import type { AuthenticatedRequest } from './authenticated-request.js'
import { AuthService } from './auth.service.js'
import { extractToken } from './extract-token.js'

const UNAUTHENTICATED_MESSAGE = 'Authentication required.'

/**
 * `@UseGuards(SessionGuard)` on `auth.logout` and `auth.me` today; every
 * merchant-only route B3 onward adds reuses it too (composed with
 * `MerchantGuard` for the merchant-only ones). Accepts either credential —
 * the web cookie or a mobile bearer token (`extractToken`) — resolves it
 * through `AuthService.resolveSession`, and rejects with the identical
 * `unauthenticated` `ApiError` whether the credential is missing entirely,
 * unrecognised, expired, or revoked: none of those distinctions is any of
 * a caller's business, the same reasoning `AuthController.login` applies
 * to "wrong password" vs "unknown user".
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()

    const token = extractToken({
      cookies: request.cookies as Record<string, string | undefined> | undefined,
      authorizationHeader: request.headers.authorization,
    })
    // (cast: cookie-parser's own types declare `cookies: Record<string, any>`
    // — narrower and non-optional purely because the middleware always runs,
    // per configureApp; extractToken's own signature stays framework-agnostic.)
    if (token === undefined) {
      throw new ApiErrorException({ code: 'unauthenticated', message: UNAUTHENTICATED_MESSAGE })
    }

    const resolved = await this.authService.resolveSession(token)
    if (resolved === undefined) {
      throw new ApiErrorException({ code: 'unauthenticated', message: UNAUTHENTICATED_MESSAGE })
    }

    request.auth = resolved
    return true
  }
}
