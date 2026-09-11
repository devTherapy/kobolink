import type { Request } from 'express'
import type { ResolvedSession } from './auth.service.js'

/**
 * `SessionGuard` attaches the resolved `{ user, session }` here once a
 * request's cookie or bearer token has checked out; `@CurrentUser()` and
 * (later) `RolesGuard` both read it back. Module augmentation, not a
 * custom `Request` subtype, because Nest hands every guard/decorator/
 * controller the same `express.Request` — a subtype would need a cast at
 * every boundary instead of once here.
 */
declare module 'express' {
  interface Request {
    auth?: ResolvedSession
  }
}

export type AuthenticatedRequest = Request
