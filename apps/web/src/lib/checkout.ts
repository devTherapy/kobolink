import { cache } from 'react'
import {
  LinkCodeSchema,
  formatNaira,
  type PublicLink,
  type PublicLinkResponse,
  type PublicLinkState,
} from '@kobolink/contracts'
import { ApiRequestError, client } from './api'

/**
 * The one place `/l/[code]` resolves a code against the public endpoint.
 * `generateMetadata` and the page component both need this exact call —
 * `cache()` (React's per-request memoization, not `fetch`'s HTTP cache — see
 * `client.links.resolve`'s own `no-store`) means they share one network
 * request instead of two, and a route segment can call it from both places
 * without either one worrying about being "the one that fetches".
 *
 * Returns a plain union instead of throwing on "not found" so a caller
 * decides for itself whether to call `notFound()` (the page) or fall back to
 * generic metadata (nothing in this PR needs that second branch today, but
 * the shape keeps `generateMetadata` from having to catch a thrown 404 to
 * answer "what title do I show" — see `not-found.tsx` for the metadata a
 * true 404 actually renders).
 */
export type CheckoutResolution = { found: true; data: PublicLinkResponse } | { found: false }

/**
 * Thrown by `resolveCheckoutLink` for anything that means "we could not find
 * out whether this link is payable" — a transport failure (the API
 * unreachable) or a 5xx/`rate_limited`/etc. response — as opposed to
 * `{ found: false }`, which means the API affirmatively answered `not_found`.
 * The route's `error.tsx` boundary (`app/l/[code]/error.tsx`) is what
 * actually renders this; it exists so that boundary can say something
 * accurate ("we couldn't reach the payment service, no money has moved")
 * instead of Next's blank generic error page, and so a raw fetch failure (no
 * `ApiRequestError` at all — see `api.ts`'s own note on that) and an explicit
 * `ApiRequestError` both funnel into the one typed shape the boundary reads.
 */
export class CheckoutUnavailableError extends Error {
  constructor(message = "We couldn't reach Kobolink's servers.") {
    super(message)
    this.name = 'CheckoutUnavailableError'
  }
}

export const resolveCheckoutLink = cache(async (code: string): Promise<CheckoutResolution> => {
  // A route param is not guaranteed to be a well-formed code — reject the
  // obviously-wrong shape before spending a request on it. `client.links
  // .resolve` re-checks the same schema internally and would answer the
  // identical `not_found` either way; this just skips the round trip.
  if (!LinkCodeSchema.safeParse(code).success) return { found: false }

  try {
    const data = await client.links.resolve(code)
    return { found: true, data }
  } catch (error) {
    if (error instanceof ApiRequestError) {
      if (error.error.code === 'not_found') return { found: false }
      // Every other `ApiError` this unauthenticated GET can plausibly answer
      // (`internal`, `rate_limited`, the `transport: true` fallback for a
      // non-JSON non-2xx body) means the link's payability is unknown, not
      // that it doesn't exist — never render a 404 for those.
      throw new CheckoutUnavailableError(error.error.message)
    }
    // A raw `fetch` failure (connection refused, DNS, ...) never produces an
    // `ApiRequestError` at all — same "could not resolve this link" story.
    throw new CheckoutUnavailableError()
  }
})

/** The OG/`<title>` copy for every state `resolveLink()` can answer. */
export function checkoutTitle(state: PublicLinkState, link: PublicLink): string {
  switch (state) {
    case 'payable':
      return link.amountKobo === null
        ? `Pay ${link.merchantName}`
        : `Pay ${formatNaira(link.amountKobo)} to ${link.merchantName}`
    case 'disabled':
      return `This link is turned off — ${link.merchantName}`
    case 'expired':
      return `This link has expired — ${link.merchantName}`
    case 'already-paid':
      return `This link has already been paid — ${link.merchantName}`
  }
}

/**
 * `Intl`-formatted, not a raw ISO string — the payer reads this, not a
 * machine. `timeZone: 'Africa/Lagos'` is pinned rather than left to the
 * runtime's default: this string is produced once on the server (SSR) and
 * must read identically if it is ever rendered again on the client, and the
 * two are not guaranteed to be in the same time zone the way "Nigerian
 * merchant, Nigerian payer, Nigerian server" might suggest — a payer's
 * device can be set to any zone. `timeZoneName: 'short'` names the zone in
 * the copy itself (e.g. "WAT") so a payer outside Lagos is not misled into
 * reading it as their own local time.
 *
 * Explicit `year`/`month`/`day`/`hour`/`minute` fields, not `dateStyle` +
 * `timeStyle`: the ECMA-402 spec forbids combining those style shorthands
 * with `timeZoneName` in the same options object (`RangeError`/
 * `TypeError: Invalid option` depending on engine) — this is the same
 * "medium date, short time" shape spelled out field by field so
 * `timeZoneName` can sit alongside it.
 */
export function formatCheckoutDate(iso: string): string {
  return new Intl.DateTimeFormat('en-NG', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Africa/Lagos',
    timeZoneName: 'short',
  }).format(new Date(iso))
}

export type NonPayableState = Exclude<PublicLinkState, 'payable'>

export interface NonPayableCopy {
  heading: string
  body: (link: PublicLink) => string
  nextStep: (link: PublicLink) => string
}

/**
 * One copy deck for every screen that has to say "you cannot pay this right
 * now" — the initial server render of a non-payable link, and `PayForm`'s
 * own `link_not_payable` branch (a single-use link a racing payer just
 * finished paying between this page loading and this payer clicking Pay).
 * Kept in one place so those two call sites cannot drift into saying it two
 * different ways.
 */
export const NON_PAYABLE_COPY: Record<NonPayableState, NonPayableCopy> = {
  disabled: {
    heading: 'This link is turned off',
    body: (link) => `${link.merchantName} has switched this payment link off.`,
    nextStep: (link) => `Ask ${link.merchantName} for a new link, or check back later.`,
  },
  expired: {
    heading: 'This link has expired',
    body: (link) =>
      link.expiresAt
        ? `This payment link expired on ${formatCheckoutDate(link.expiresAt)}.`
        : 'This payment link has expired.',
    nextStep: (link) => `Ask ${link.merchantName} for a new link.`,
  },
  'already-paid': {
    heading: 'This link has already been paid',
    body: () => 'This is a single-use link and it has already been used.',
    nextStep: (link) =>
      `If you were expecting to pay just now, contact ${link.merchantName} to confirm your payment or request a new link.`,
  },
}
