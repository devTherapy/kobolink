import type { LinkStatus, displayStatus } from '@kobolink/contracts'
import { ApiRequestError } from './api'

/**
 * The state the badge shows — `displayStatus()`'s answer, which folds expiry
 * and single-use exhaustion into the stored `active` / `disabled`.
 */
export type DisplayedLinkStatus = ReturnType<typeof displayStatus>

/**
 * Where a signed-out merchant lands to sign back in and come straight back to
 * `path`. `path` is always one of this app's own routes (never user input), so
 * it is same-origin by construction; it is encoded because it rides in a query.
 */
export function signInHref(path: string): string {
  return `/login?next=${encodeURIComponent(path)}`
}

/** Did the API say the session is gone? Signing in is the only fix, so callers offer it. */
export function isSessionExpired(error: unknown): boolean {
  return error instanceof ApiRequestError && error.error.code === 'unauthenticated'
}

/** What the link really is right now, in words, for a message that follows a failed change. */
const REALITY: Record<DisplayedLinkStatus, string> = {
  Active: "It's still accepting payments",
  Disabled: "It's still turned off",
  Expired: "It's still expired, so it isn't accepting payments",
  Paid: "It's still paid, so it isn't accepting another payment",
}

/**
 * What to tell a merchant whose status switch failed. Names what went wrong,
 * says what state the link is *really* in, and says that no payments were
 * affected — a status change moves no money, but a merchant mid-incident wants
 * that said, not assumed.
 *
 * `current` is the derived `displayStatus` of the last server-confirmed link —
 * the same word the badge shows — not a guess from the attempted action: an
 * expired or spent link is not "still accepting payments" however the switch
 * was flipped.
 *
 * Its own module, not part of `link-detail.ts`: that file reads the session
 * cookie through `next/headers`, which must never be pulled into the client
 * bundle the status switch lives in.
 */
export function describeStatusFailure(error: unknown, attempted: LinkStatus, current: DisplayedLinkStatus): string {
  const action = attempted === 'disabled' ? 'turn off' : 'turn on'
  const reality = REALITY[current]

  // Only the codes a status PATCH can meaningfully answer get their own words;
  // everything else (a 5xx, a dropped connection, contract drift) is the same
  // "the server didn't confirm it" below.
  const code = error instanceof ApiRequestError ? error.error.code : null
  if (code === 'unauthenticated') {
    return `Your session has expired, so we couldn't ${action} this link. ${reality}, and no payments were affected.`
  }
  if (code === 'not_found') {
    return `We couldn't ${action} this link because it no longer exists on your account. Go back to your links to check.`
  }
  if (code === 'forbidden') {
    return `This account isn't allowed to change links. ${reality}, and no payments were affected.`
  }
  if (code === 'rate_limited') {
    return `Too many changes in a short time, so we couldn't ${action} this link. ${reality}, and no payments were affected. Wait a moment and try again.`
  }
  return `We couldn't ${action} this link — Kobolink's servers didn't confirm the change. ${reality}, and no payments were affected. Try again.`
}
