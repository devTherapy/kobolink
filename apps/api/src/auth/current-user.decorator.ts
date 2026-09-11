import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { User } from '@kobolink/contracts'
import type { ResolvedSession } from './auth.service.js'
import type { AuthenticatedRequest } from './authenticated-request.js'

/**
 * Reads back what `SessionGuard` already resolved onto `request.auth`, so a
 * handler never re-derives it from the raw cookie/bearer token. Both
 * decorators throw — a programming error, not a runtime condition — if used
 * on a route that is not actually behind `SessionGuard`, since `request.auth`
 * would then never have been set.
 */
function requireAuth(context: ExecutionContext): ResolvedSession {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
  if (request.auth === undefined) {
    throw new Error('@CurrentUser()/@CurrentSession() used on a route with no SessionGuard ahead of it')
  }
  return request.auth
}

/** `@CurrentUser() user: User` — the authenticated user, contract-shaped. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): User => {
  return requireAuth(context).user
})

/** `@CurrentSession() session: ResolvedSession` — user plus the raw session row (e.g. for `session.id` on logout). */
export const CurrentSession = createParamDecorator((_data: unknown, context: ExecutionContext): ResolvedSession => {
  return requireAuth(context)
})
