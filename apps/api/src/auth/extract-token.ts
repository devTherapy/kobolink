import { SESSION_COOKIE_NAME } from './session-cookie.js'

/**
 * `SessionGuard` accepts either credential (DESIGN-SPEC.md §5): the web
 * cookie or a mobile `Authorization: Bearer <token>` header. Pure function
 * of plain values — cookie-parser's already-parsed `req.cookies` and the
 * raw `Authorization` header — so it is unit testable without constructing
 * an Express `Request`.
 */
export interface TokenSource {
  cookies: Record<string, string | undefined> | undefined
  authorizationHeader: string | undefined
}

const BEARER_PREFIX = /^Bearer (.+)$/

/** If both are present, the explicit bearer header wins — it can only have been sent deliberately by a mobile client. */
export function extractToken(source: TokenSource): string | undefined {
  const match = source.authorizationHeader !== undefined ? BEARER_PREFIX.exec(source.authorizationHeader) : null
  const bearerToken = match?.[1]
  if (bearerToken !== undefined && bearerToken.length > 0) return bearerToken

  const cookieToken = source.cookies?.[SESSION_COOKIE_NAME]
  if (cookieToken !== undefined && cookieToken.length > 0) return cookieToken

  return undefined
}
