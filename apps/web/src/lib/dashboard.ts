import type { DashboardStats, LinkListResponse } from '@kobolink/contracts'
import { ApiRequestError, client } from './api'
import { classifyReadFailure } from './read-failure'
import { resolveCookieHeader } from './session'

export interface DashboardData {
  stats: DashboardStats
  links: LinkListResponse
}

/**
 * Thrown by `loadDashboardData` for the failures worth retrying — a transport
 * failure or a 5xx/`rate_limited` response — mirroring `CheckoutUnavailableError`
 * in `./checkout`. `app/dashboard/error.tsx` is what actually renders this, so
 * it can say something accurate instead of Next's blank generic error page.
 *
 * It is deliberately *not* the answer for every failure: a session that ended
 * redirects to sign-in, a customer-role `forbidden` is `MerchantAccessError`
 * and a body that breaks the contract is `UnexpectedResponseError` (see
 * `classifyReadFailure`), because a retry cannot fix any of those.
 */
export class DashboardUnavailableError extends Error {
  constructor(message = "We couldn't reach Kobolink's servers.", options?: ErrorOptions) {
    super(message, options)
    this.name = 'DashboardUnavailableError'
  }
}

/**
 * The one place `/dashboard` resolves its stat strip and links table. Both
 * calls are merchant-scoped reads of the same session cookie
 * `DashboardLayout` already validated, and neither depends on the other's
 * result — `Promise.all`, not two sequential `await`s, so the page pays for
 * one round trip's worth of latency instead of two (`async-parallel`).
 *
 * A Server Component has no browser cookie jar behind it, so the httpOnly
 * session cookie only reaches the API if it is forwarded by hand — the same
 * reasoning `getSession` documents for `auth.me`.
 */
export async function loadDashboardData(cookieHeader?: string): Promise<DashboardData> {
  const cookie = await resolveCookieHeader(cookieHeader)
  const init = cookie ? { headers: { cookie } } : {}

  try {
    const [stats, links] = await Promise.all([
      client.dashboard.stats(init),
      client.links.list(undefined, init),
    ])
    return { stats, links }
  } catch (error) {
    // Redirects, or throws `MerchantAccessError` / `UnexpectedResponseError`,
    // for the failures a retry cannot fix; returns for the ones it can.
    classifyReadFailure(error, '/dashboard')
    if (error instanceof ApiRequestError) throw new DashboardUnavailableError(error.error.message, { cause: error })
    // A raw `fetch` failure (connection refused, DNS, ...) never produces an
    // `ApiRequestError` at all — same "could not load the dashboard" story.
    throw new DashboardUnavailableError(undefined, { cause: error })
  }
}
