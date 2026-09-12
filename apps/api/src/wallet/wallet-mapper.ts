import { z } from 'zod'
import { type WalletTransaction, WalletTransactionSchema } from '@kobolink/contracts'
import { toIso } from '../db/iso-timestamp.js'
import type * as schema from '../db/schema/index.js'

/**
 * The shape `WalletService` writes into `postings.metadata` for every
 * `kind: 'transfer'`/`kind: 'topup'` posting — same idea as
 * `payments/payment-mapper.ts`'s `PostingLinkPaymentMetadataSchema`: the
 * ledger's own `ledger_entries` rows are still the only source of truth for
 * *whether* and *how much* money moved (`WalletService`'s balance reads
 * never touch this), but a `WalletTransaction` also needs to name a human
 * counterparty and (for a transfer) an optional note, neither of which a
 * signed integer on a debit/credit pair can answer.
 *
 * `senderUserId`/`senderDisplayName` are both null only for a `topup` — the
 * other leg is the `external_funding` singleton, not a `users` row (see
 * `db/schema/ledger-accounts.ts`'s own doc comment for why that account can
 * never be owned by one). Captured once, at write time, the same discipline
 * `PostingLinkPaymentMetadataSchema`'s doc comment gives for `payerName`:
 * a display name changing later must not silently rewrite an old
 * transaction's counterparty.
 */
export const PostingWalletMetadataSchema = z.object({
  senderUserId: z.string().nullable(),
  senderDisplayName: z.string().nullable(),
  recipientUserId: z.string(),
  recipientDisplayName: z.string(),
  note: z.string().max(140).nullable(),
})
export type PostingWalletMetadata = z.infer<typeof PostingWalletMetadataSchema>

/**
 * `WalletTransactionSchema.parse` (not `.safeParse`) — same discipline as
 * `payment-mapper.ts`'s `rowToPayment`: a drift here must fail loudly as a
 * 500 in the integration suite, never silently serialise a body that
 * doesn't actually satisfy `WalletTransaction`.
 *
 * `entryAmountKobo` is signed from the *caller's own* wallet account's
 * point of view (negative is money out) — `WalletService` reads it
 * straight off that account's own `ledger_entries` row, never derives it
 * from `metadata`, so this function only ever has to decide who the
 * counterparty *name* is: the recipient's, if this entry is the debit
 * (money leaving this account), the sender's if it's the credit — a
 * `topup`'s only human party is the recipient (the caller), so it has no
 * counterparty at all.
 */
export function rowToWalletTransaction(posting: typeof schema.postings.$inferSelect, entryAmountKobo: number): WalletTransaction {
  const metadata = PostingWalletMetadataSchema.parse(posting.metadata)
  const counterparty = posting.kind === 'topup' ? null : entryAmountKobo < 0 ? metadata.recipientDisplayName : metadata.senderDisplayName

  return WalletTransactionSchema.parse({
    postingId: posting.id,
    kind: posting.kind,
    amountKobo: entryAmountKobo,
    counterparty,
    note: metadata.note,
    createdAt: toIso(posting.createdAt),
  })
}
