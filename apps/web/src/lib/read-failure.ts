import { redirect } from 'next/navigation'
import { ZodError } from 'zod'
import { ApiRequestError } from './api'
import { signInHref } from './link-status'

/**
 * The API answered `forbidden`: the visitor is signed in, but with an account
 * that is not a merchant (`MerchantGuard`, B-side: a customer gets 403, not 401).
 * Signing in again changes nothing and neither does a retry, so a screen must
 * never present this as "couldn't reach the servers".
 */
export class MerchantAccessError extends Error {
  constructor(message = 'This account is not a merchant account.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'MerchantAccessError'
  }
}

/**
 * The API answered, but the body does not match the contract (a `ZodError` from
 * `request()`'s schema parse). That is a defect on our side — deploy skew or a
 * contract change — not a connectivity problem, and a different thing to tell
 * the visitor and whoever reads the logs. `cause` keeps the `ZodError`.
 */
export class UnexpectedResponseError extends Error {
  constructor(message = 'Kobolink answered with a response this app could not read.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'UnexpectedResponseError'
  }
}

/**
 * Sorts the failure of a merchant-scoped read (a Server Component's fetch of
 * the caller's own data) into its class, before a caller falls back to its own
 * retryable "unavailable" error:
 *
 *  - `unauthenticated` redirects to sign-in and returns the visitor to
 *    `signInPath` afterwards — signing in again is the only fix. Matched on the
 *    API's own `code`: a bare 401 from a proxy has no `ApiError` body, arrives
 *    as `internal`, and is not evidence the session ended.
 *  - `forbidden` throws `MerchantAccessError`.
 *  - a `ZodError` throws `UnexpectedResponseError`.
 *
 * Anything else — a transport failure, a 5xx, `rate_limited` — returns, so the
 * caller throws its own retryable error. Those are the only failures worth a
 * "Try again".
 *
 * Each of the three non-retryable classes is rendered by the page itself rather
 * than left to an `error.tsx` boundary: in production Next replaces a thrown
 * Server Component error's name and message with an opaque digest, so a
 * boundary cannot tell these classes apart and would show all of them as the
 * same retryable failure.
 */
export function classifyReadFailure(error: unknown, signInPath: string): void {
  if (error instanceof ApiRequestError) {
    if (error.error.code === 'unauthenticated') redirect(signInHref(signInPath))
    if (error.error.code === 'forbidden') throw new MerchantAccessError(error.error.message, { cause: error })
    return
  }
  if (error instanceof ZodError) throw new UnexpectedResponseError(undefined, { cause: error })
}
