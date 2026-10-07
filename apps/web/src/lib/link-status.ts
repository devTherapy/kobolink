import type { LinkStatus } from '@kobolink/contracts'
import { ApiRequestError } from './api'

/**
 * What to tell a merchant whose status switch failed. Names what went wrong,
 * says what state the link is really in (the switch has already snapped back
 * to it), and says that no payments were affected — a status change moves no
 * money, but a merchant mid-incident wants that said, not assumed.
 *
 * Its own module, not part of `link-detail.ts`: that file reads the session
 * cookie through `next/headers`, which must never be pulled into the client
 * bundle the status switch lives in.
 */
export function describeStatusFailure(error: unknown, attempted: LinkStatus): string {
  const action = attempted === 'disabled' ? 'turn off' : 'turn on'
  const reality = attempted === 'disabled' ? 'still accepting payments' : 'still turned off'

  // Only the codes a status PATCH can meaningfully answer get their own words;
  // everything else (a 5xx, a dropped connection, contract drift) is the same
  // "the server didn't confirm it" below.
  const code = error instanceof ApiRequestError ? error.error.code : null
  if (code === 'unauthenticated') {
    return `Your session has expired, so we couldn't ${action} this link. It's ${reality}. Sign in again, then try once more.`
  }
  if (code === 'not_found') {
    return `We couldn't ${action} this link because it no longer exists on your account. Go back to your links to check.`
  }
  if (code === 'forbidden') {
    return `This account isn't allowed to change links, so the link is ${reality}.`
  }
  if (code === 'rate_limited') {
    return `Too many changes in a short time, so we couldn't ${action} this link. It's ${reality}. Wait a moment and try again.`
  }
  return `We couldn't ${action} this link — Kobolink's servers didn't confirm the change. It's ${reality}, and no payments were affected. Try again.`
}
