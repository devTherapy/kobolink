import { cache } from 'react'
import { cookies as nextCookies } from 'next/headers'
import type { User } from '@kobolink/contracts'
import { client } from './api'

export interface Session {
  user: User
}

/**
 * A server-side `fetch` (Server Component, route handler, this file's own
 * `getSession`) has no browser behind it, so the httpOnly `kobolink_session`
 * cookie the API set never rides along automatically the way it does for a
 * client-side `fetch` in the browser (DESIGN-SPEC §5: "the browser never
 * sees a token" — that guarantee is about *client JavaScript*, not about
 * this server-side plumbing, which has to move the raw cookie header by
 * hand). `next/headers`' `cookies()` gives the incoming request's cookie
 * jar for the *current* request; `.toString()` re-serialises it back into
 * the exact `Cookie` header format `auth.me` needs to forward it on.
 *
 * Accepting an explicit `cookieHeader` too (rather than always reading
 * `next/headers` itself) is what makes `getSession` callable from outside a
 * Next request context — a plain unit test, or a caller that already has
 * the header value some other way — without needing to mock `next/headers`.
 *
 * Exported because `src/lib/dashboard.ts`'s `loadDashboardData` needs the
 * exact same seam for the same reason (forwarding the session cookie to
 * `dashboard.stats`/`links.list` from a Server Component) — one copy of the
 * "explicit cookie header, else read `next/headers`" logic, not two.
 */
export async function resolveCookieHeader(explicit: string | undefined): Promise<string> {
  if (explicit !== undefined) return explicit
  const store = await nextCookies()
  return store.toString()
}

/**
 * The one place `apps/web` asks "who, if anyone, is signed in" on the
 * server — Server Components, route handlers, and the dashboard layout's
 * redirect all call this rather than hitting `client.auth.me` directly.
 *
 * `cache()` (React's per-request memoisation) means a route segment that
 * calls this more than once in the same request — the dashboard layout and
 * a page beneath it both wanting the merchant's name, say — shares one
 * network round trip instead of paying for it twice.
 *
 * Deliberately fails closed: `unauthenticated` (expired/revoked session)
 * and every other failure this call can produce — a network error, a 5xx,
 * a malformed response — all resolve to `null`, "treat as signed out."
 * Failing open on an infrastructure hiccup would mean a merchant's own
 * browser occasionally renders the dashboard with no session behind it at
 * all; a spurious redirect to `/login` is the safer failure for an
 * authenticated app to make.
 */
export const getSession = cache(async (cookieHeader?: string): Promise<Session | null> => {
  const cookie = await resolveCookieHeader(cookieHeader)
  if (!cookie) return null

  try {
    const { user } = await client.auth.me({ headers: { cookie } })
    return { user }
  } catch {
    // `ApiRequestError` (`unauthenticated`, or any other status this
    // unauthenticated-cookie GET can answer) and a raw transport failure
    // both land here — see the doc comment above for why both fail closed.
    return null
  }
})
