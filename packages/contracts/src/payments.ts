import { z } from 'zod'
import {
  AmountKoboSchema,
  CurrencySchema,
  DisplayNameSchema,
  EmailSchema,
  IsoDateTimeSchema,
  LinkCodeSchema,
  PaymentReferenceSchema,
  pageOf,
} from './primitives.js'

/**
 * The checkout flow mirrors Paystack's shape deliberately: initialize, then
 * verify. Both are money-moving writes and both carry an Idempotency-Key
 * header; a replayed key returns the original result, never a second posting.
 *
 * The gateway is simulated: a payer email beginning `fail@` declines.
 */
export const SIMULATED_DECLINE_PREFIX = 'fail@' as const

export const PaymentStatusSchema = z.enum(['pending', 'success', 'failed']).meta({ id: 'PaymentStatus' })
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>

export const InitializeCheckoutRequestSchema = z
  .object({
    code: LinkCodeSchema,
    /** Required when the link has no fixed amount; must equal it when it does. */
    amountKobo: AmountKoboSchema,
    payerName: DisplayNameSchema,
    payerEmail: EmailSchema,
  })
  .meta({ id: 'InitializeCheckoutRequest' })
export type InitializeCheckoutRequest = z.infer<typeof InitializeCheckoutRequestSchema>

export const InitializeCheckoutResponseSchema = z
  .object({
    reference: PaymentReferenceSchema,
    code: LinkCodeSchema,
    amountKobo: AmountKoboSchema,
    currency: CurrencySchema,
    status: z.literal('pending'),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'InitializeCheckoutResponse' })
export type InitializeCheckoutResponse = z.infer<typeof InitializeCheckoutResponseSchema>

export const VerifyCheckoutRequestSchema = z
  .object({ reference: PaymentReferenceSchema })
  .meta({ id: 'VerifyCheckoutRequest' })
export type VerifyCheckoutRequest = z.infer<typeof VerifyCheckoutRequestSchema>

/**
 * A payment as the merchant (link detail) or the payer (result screen) sees
 * it. It is a *projection* of a posting; the ledger rows behind it are never
 * exposed and never written by a client.
 */
export const PaymentSchema = z
  .object({
    reference: PaymentReferenceSchema,
    code: LinkCodeSchema,
    amountKobo: AmountKoboSchema,
    currency: CurrencySchema,
    status: PaymentStatusSchema,
    payerName: DisplayNameSchema,
    /** Masked for the merchant view: "a***@example.com". */
    payerEmail: z.string().min(3).max(254),
    createdAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.nullable(),
    /** Present on failure: what went wrong, in words a payer can act on. */
    failureReason: z.string().max(200).nullable(),
  })
  .meta({ id: 'Payment' })
export type Payment = z.infer<typeof PaymentSchema>

export const VerifyCheckoutResponseSchema = z
  .object({ payment: PaymentSchema })
  .meta({ id: 'VerifyCheckoutResponse' })
export type VerifyCheckoutResponse = z.infer<typeof VerifyCheckoutResponseSchema>

export const PaymentListResponseSchema = pageOf(PaymentSchema, 'PaymentListResponse')
export type PaymentListResponse = z.infer<typeof PaymentListResponseSchema>

/** Does the simulated gateway decline this payer? */
export function isSimulatedDecline(payerEmail: string): boolean {
  return payerEmail.trim().toLowerCase().startsWith(SIMULATED_DECLINE_PREFIX)
}

/** Mask an email for a merchant-facing view: keep the first character and the domain. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return '***'
  return `${email[0]}***${email.slice(at)}`
}
