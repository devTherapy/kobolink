import { z } from 'zod'
import {
  AmountKoboSchema,
  CurrencySchema,
  DisplayNameSchema,
  IdSchema,
  IsoDateTimeSchema,
  PhoneSchema,
  pageOf,
} from './primitives.js'

/**
 * Phase 2. A wallet is just another `ledger_accounts.kind`, a transfer is
 * just another posting pair. Nothing here changes the Phase 1 tables.
 */
export const LedgerAccountKindSchema = z
  .enum(['wallet', 'merchant_receivable', 'external_funding'])
  .meta({ id: 'LedgerAccountKind' })
export type LedgerAccountKind = z.infer<typeof LedgerAccountKindSchema>

export const PostingKindSchema = z.enum(['link_payment', 'transfer', 'topup']).meta({ id: 'PostingKind' })
export type PostingKind = z.infer<typeof PostingKindSchema>

/** Balances are signed: a wallet can never go below zero, a funding account always is. */
export const SignedKoboSchema = z.int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)

export const WalletSchema = z
  .object({
    accountId: IdSchema,
    currency: CurrencySchema,
    balanceKobo: SignedKoboSchema,
    asOf: IsoDateTimeSchema,
  })
  .meta({ id: 'Wallet' })
export type Wallet = z.infer<typeof WalletSchema>

export const TransferRequestSchema = z
  .object({
    toPhone: PhoneSchema,
    amountKobo: AmountKoboSchema,
    note: z.string().trim().max(140).optional(),
  })
  .meta({ id: 'TransferRequest' })
export type TransferRequest = z.infer<typeof TransferRequestSchema>

export const TopUpRequestSchema = z
  .object({ amountKobo: AmountKoboSchema })
  .meta({ id: 'TopUpRequest', description: 'Simulated funding. No real money enters the system.' })
export type TopUpRequest = z.infer<typeof TopUpRequestSchema>

export const WalletTransactionSchema = z
  .object({
    postingId: IdSchema,
    kind: PostingKindSchema,
    /** Signed from this wallet's point of view: negative is money out. */
    amountKobo: SignedKoboSchema,
    counterparty: DisplayNameSchema.nullable(),
    note: z.string().max(140).nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'WalletTransaction' })
export type WalletTransaction = z.infer<typeof WalletTransactionSchema>

export const TransferResponseSchema = z
  .object({ transaction: WalletTransactionSchema, wallet: WalletSchema })
  .meta({ id: 'TransferResponse' })
export type TransferResponse = z.infer<typeof TransferResponseSchema>

export const WalletTransactionListResponseSchema = pageOf(WalletTransactionSchema, 'WalletTransactionListResponse')
export type WalletTransactionListResponse = z.infer<typeof WalletTransactionListResponseSchema>

/**
 * What a QR code encodes for "scan to pay". Versioned so a future format can
 * be told apart; a scanner refuses an unknown version rather than guessing.
 */
export const QR_PAYLOAD_VERSION = 1 as const
export const QrPayloadSchema = z
  .object({
    v: z.literal(QR_PAYLOAD_VERSION),
    toPhone: PhoneSchema,
    displayName: DisplayNameSchema,
    amountKobo: AmountKoboSchema.nullable(),
  })
  .meta({ id: 'QrPayload' })
export type QrPayload = z.infer<typeof QrPayloadSchema>
