import type { CreateLinkRequest, PaymentLink } from '@kobolink/contracts'
import { ApiRequestError, client } from './api'

/**
 * How many times the browser re-submits after a `conflict` before giving up
 * and telling the merchant. Not a loop around the API's own retries — that
 * one (`LinksService.create`, up to 8 attempts) already ran inside the
 * request that came back `conflict`; this is the second, outer net, for the
 * case where those eight draws all collided (or the generator was briefly
 * broken). Two more tries means at most 3 requests: past that, "try again"
 * is the honest answer, not a spinner that never ends.
 */
export const MAX_CONFLICT_RETRIES = 2

/**
 * Whether this failure is the API's "I could not allocate a unique link
 * code" (`conflict` from `POST /api/links`). `CreateLinkRequestSchema` has
 * no client-chosen code, so a link-create `conflict` can only mean the code
 * collided: nothing was inserted, which is what makes a blind re-submit safe
 * — it cannot create a second link. A transport failure is deliberately NOT
 * retried here: the request may have been processed, and re-sending it could
 * create a duplicate (the contract has no idempotency header for link
 * creation).
 */
function isCodeCollision(error: unknown): boolean {
  return (
    error instanceof ApiRequestError && !error.transport && error.status === 409 && error.error.code === 'conflict'
  )
}

/**
 * `POST /api/links`, re-submitting invisibly on a code collision (PLAN.md F4
 * "Done when": a duplicate code retries invisibly). The merchant never sees
 * the first attempts: the form's loading state simply lasts a beat longer. Only
 * once the retries are spent does the last `conflict` surface to the caller.
 *
 * `create` is injectable so the retry policy can be unit-tested without a
 * network, in the same spirit as `LinksService`'s injectable code generator.
 */
export async function createLinkWithRetry(
  body: CreateLinkRequest,
  create: (body: CreateLinkRequest) => Promise<PaymentLink> = client.links.create,
): Promise<PaymentLink> {
  for (let retries = 0; ; retries++) {
    try {
      return await create(body)
    } catch (error) {
      if (!isCodeCollision(error) || retries >= MAX_CONFLICT_RETRIES) throw error
    }
  }
}
