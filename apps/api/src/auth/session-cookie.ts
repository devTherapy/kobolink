/**
 * The web session lives in an httpOnly, Secure (outside `development`),
 * SameSite=Lax cookie — DESIGN-SPEC.md §5. `SESSION_LIFETIME_MS` backs both
 * the cookie's `Max-Age` and `sessions.expires_at`: web and mobile share
 * one constant, 30 days, rather than two lifetimes that could quietly
 * drift apart.
 */
export const SESSION_COOKIE_NAME = 'kobolink_session'
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The subset of Express's `CookieOptions` this app actually sets — kept
 * narrow and local so `buildSessionCookieOptions`/`buildClearCookieOptions`
 * stay pure functions of a plain string (`NODE_ENV`), not of an Express
 * `Response`, and so a unit test can assert their shape with no HTTP
 * framework involved at all.
 */
export interface SessionCookieOptions {
  httpOnly: true
  secure: boolean
  sameSite: 'lax'
  path: '/'
  maxAge?: number
}

/**
 * `Secure` outside `development` — a plain-HTTP local dev server (no TLS)
 * cannot set a `Secure` cookie at all in most browsers, but everywhere else
 * (staging, production, and by default whenever `NODE_ENV` is merely
 * unset) the safer default wins. Takes `nodeEnv` as a parameter rather than
 * reading `process.env.NODE_ENV` itself so this stays a pure function —
 * the one call site (`auth.controller.ts`) reads the environment once and
 * passes it in.
 */
export function isDevelopmentEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'development'
}

/** Options for `res.cookie(SESSION_COOKIE_NAME, token, ...)` on register/login. */
export function buildSessionCookieOptions(nodeEnv: string | undefined): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: !isDevelopmentEnv(nodeEnv),
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_LIFETIME_MS,
  }
}

/**
 * Options for `res.clearCookie(SESSION_COOKIE_NAME, ...)` on logout. A
 * browser only actually clears a cookie when `path` (and `domain`, unset on
 * both sides here) match the cookie that was set — `maxAge` is deliberately
 * left out; Express's `clearCookie` sets its own `Expires` in the past
 * regardless of what `maxAge` says.
 */
export function buildClearCookieOptions(nodeEnv: string | undefined): Omit<SessionCookieOptions, 'maxAge'> {
  return {
    httpOnly: true,
    secure: !isDevelopmentEnv(nodeEnv),
    sameSite: 'lax',
    path: '/',
  }
}
