import { z } from 'zod'
import { type Payment, PaymentSchema } from '@kobolink/contracts'
import { toIso } from '../db/iso-timestamp.js'
import type * as schema from '../db/schema/index.js'

/**
 * The shape `PaymentsService` writes into `postings.metadata` for every
 * `kind: 'link_payment'` posting it ever creates — success or decline
 * alike. `postings` is append-only (`drizzle/0002_ledger_entries_append_
 * only.sql`), so this is written exactly once, atomically, in the same
 * `INSERT` that (for a success) shares a transaction with its balancing
 * `ledger_entries`; nothing ever edits it afterward.
 *
 * This is not a second source of truth standing in for the ledger: the
 * *fact* that money moved is still only ever the `ledger_entries` rows
 * themselves — `links/link-stats.ts`'s `computeLinkStats` never reads this
 * metadata, only entries and account kinds. What lives here is the rest of
 * a `Payment` the ledger alone cannot answer (who paid, in what name, and —
 * for a decline — why not), captured once at the moment of decision so
 * `GET .../payments` and a repeat `checkout.verify` can project it back
 * without a second query for information the ledger was never going to
 * carry in the first place (a debit/credit pair has no `payerName`).
 */
export const PostingLinkPaymentMetadataSchema = z.object({
  linkCode: z.string(),
  amountKobo: z.number().int(),
  payerName: z.string(),
  /** Already masked (`maskEmail`) at write time — never the raw address, on either outcome. */
  payerEmail: z.string(),
  status: z.enum(['success', 'failed']),
  failureReason: z.string().nullable(),
})
export type PostingLinkPaymentMetadata = z.infer<typeof PostingLinkPaymentMetadataSchema>

/**
 * `PaymentSchema.parse` (not `.safeParse`) — same discipline as
 * `links/link-mapper.ts`'s `toPaymentLink`: a drift between this mapper and
 * the contract must fail loudly as a 500 in the integration suite, never
 * silently serialise a body that doesn't actually satisfy `Payment`.
 * `createdAt`/`completedAt` are both the posting's own `createdAt`: a
 * `Payment` is only ever born decided (`PaymentsService` never persists a
 * pending one), so the moment it was created and the moment it completed
 * are the same instant by construction.
 */
export function rowToPayment(row: typeof schema.postings.$inferSelect): Payment {
  const metadata = PostingLinkPaymentMetadataSchema.parse(row.metadata)
  return PaymentSchema.parse({
    reference: row.reference,
    code: metadata.linkCode,
    amountKobo: metadata.amountKobo,
    currency: 'NGN',
    status: metadata.status,
    payerName: metadata.payerName,
    payerEmail: metadata.payerEmail,
    createdAt: toIso(row.createdAt),
    completedAt: toIso(row.createdAt),
    failureReason: metadata.failureReason,
    moneyMoved: metadata.status === 'success',
  })
}
