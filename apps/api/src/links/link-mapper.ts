import { type PaymentLink, PaymentLinkSchema } from '@kobolink/contracts'
import { toIso } from '../db/iso-timestamp.js'
import type * as schema from '../db/schema/index.js'

/**
 * The one place a `links` row becomes the contract's `PaymentLink`.
 * `PaymentLinkSchema.parse` (not `.safeParse`) is deliberate: a drift between
 * this mapper and the contract — a column renamed, a type narrowed
 * differently — must fail loudly as a 500 in the integration suite, never
 * silently serialise a body that doesn't actually satisfy `PaymentLink`.
 *
 * `merchantName` and the counters are supplied by the caller rather than
 * read off the row: every route in `LinksController` is merchant-scoped, so
 * `merchantName` is always the caller's own `User.displayName` (no second
 * query), and the counters are `LinksService`'s own derived-from-postings
 * read (`computeLinkStats`/`computeLinkStatsBatch`), always `0` until B5.
 */
export function toPaymentLink(
  row: typeof schema.links.$inferSelect,
  merchantName: string,
  paymentCount: number,
  totalPaidKobo: number,
): PaymentLink {
  return PaymentLinkSchema.parse({
    code: row.code,
    merchantId: row.merchantUserId,
    merchantName,
    title: row.title,
    description: row.description,
    amountKobo: row.amountKobo,
    currency: 'NGN',
    status: row.status,
    isReusable: row.isReusable,
    expiresAt: row.expiresAt === null ? null : toIso(row.expiresAt),
    createdAt: toIso(row.createdAt),
    paymentCount,
    totalPaidKobo,
  })
}
