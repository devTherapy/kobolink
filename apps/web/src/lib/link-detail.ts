import { cache } from 'react'
import { redirect } from 'next/navigation'
import { LinkCodeSchema, type PaymentLink, type PaymentListResponse } from '@kobolink/contracts'
import { ApiRequestError, client } from './api'
import { resolveCookieHeader } from './session'

export interface LinkDetailData {
  link: PaymentLink
  /** The first page only — "Show more" on the payments table fetches the rest. */
  payments: PaymentListResponse
}

export type LinkDetailResolution = { found: true; data: LinkDetailData } | { found: false }

/**
 * Thrown by `loadLinkDetail` for anything that means "we could not find out
 * what this link looks like" — a transport failure or a 5xx — as opposed to
 * `{ found: false }`, which is the API affirmatively answering `not_found`.
 * `app/dashboard/links/[code]/error.tsx` renders it; same split as
 * `CheckoutUnavailableError` / `DashboardUnavailableError`.
 */
export class LinkDetailUnavailableError extends Error {
  constructor(message = "We couldn't reach Kobolink's servers.", options?: ErrorOptions) {
    super(message, options)
    this.name = 'LinkDetailUnavailableError'
  }
}

/**
 * The one place `/dashboard/links/[code]` loads a link and its payments.
 * `generateMetadata` and the page both need it, so `cache()` makes them share
 * one pair of requests instead of paying twice.
 *
 * The two reads are independent — neither needs the other's result — so they
 * run in `Promise.all` (`async-parallel`). A link that is not the caller's
 * (or does not exist, or has a malformed code) is `not_found` from *both*
 * endpoints, on purpose (B3: another merchant gets 404, not 403), and either
 * one answering it is enough to render the not-found state.
 *
 * A Server Component has no browser cookie jar, so the session cookie is
 * forwarded by hand — the same seam `loadDashboardData` uses.
 *
 * A session that expired between the layout's check and this fetch answers
 * `unauthenticated`; that is "sign in again", not "servers unreachable", so it
 * redirects to the login screen and returns the merchant to this link after.
 */
export const loadLinkDetail = cache(async (code: string, cookieHeader?: string): Promise<LinkDetailResolution> => {
  // A route param is not guaranteed to be a well-formed code; the API client
  // would answer the same `not_found` without a request, this just says so first.
  if (!LinkCodeSchema.safeParse(code).success) return { found: false }

  const cookie = await resolveCookieHeader(cookieHeader)
  const init = cookie ? { headers: { cookie } } : {}

  try {
    const [link, payments] = await Promise.all([
      client.links.get(code, init),
      client.links.payments(code, undefined, init),
    ])
    return { found: true, data: { link, payments } }
  } catch (error) {
    if (error instanceof ApiRequestError) {
      if (error.error.code === 'not_found') return { found: false }
      if (error.error.code === 'unauthenticated') {
        redirect(`/login?next=${encodeURIComponent(`/dashboard/links/${code}`)}`)
      }
      throw new LinkDetailUnavailableError(error.error.message, { cause: error })
    }
    // A raw `fetch` failure never produces an `ApiRequestError` at all; a
    // `ZodError` from contract drift lands here too, so keep `cause`.
    throw new LinkDetailUnavailableError(undefined, { cause: error })
  }
})
