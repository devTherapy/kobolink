import { NextResponse, type NextRequest } from 'next/server'

/**
 * Mirrors `SESSION_COOKIE_NAME` from `apps/api/src/auth/session-cookie.ts` —
 * `apps/web` does not import across the service boundary, so the name is
 * duplicated here rather than shared. This is a *presence* check only: the
 * value is never read or decoded, only whether the browser sent a cookie by
 * this name at all. A stale or revoked session still has this cookie
 * present — catching that is the dashboard layout's job
 * (`src/app/dashboard/layout.tsx`), via the real `auth.me` round trip.
 */
const SESSION_COOKIE_NAME = 'kobolink_session'

/**
 * Route protection's cheap half (PLAN.md F2 "Done when": signed-out access
 * to `/dashboard` redirects). Edge middleware runs on every matched
 * navigation, so it deliberately does *not* call `getSession()` — that
 * would mean an `auth.me` network round trip on every dashboard navigation
 * just to answer a question a cookie's mere presence already answers for
 * the common case (no cookie at all = definitely signed out). The
 * authoritative check — is this cookie's session still valid — happens
 * once, server-side, in the dashboard layout.
 *
 * `next` is built from `request.nextUrl` itself (this app's own router),
 * never from anything a caller supplies, so it is same-origin by
 * construction — no separate validation needed here the way `LoginForm`
 * needs `sameOriginPath` for a `next` a stranger's URL could set.
 */
export function middleware(request: NextRequest): NextResponse {
  if (request.cookies.has(SESSION_COOKIE_NAME)) {
    return NextResponse.next()
  }

  const loginUrl = new URL('/login', request.url)
  loginUrl.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`)
  return NextResponse.redirect(loginUrl)
}

export const config = {
  matcher: ['/dashboard', '/dashboard/:path*'],
}
