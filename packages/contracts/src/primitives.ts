import { z } from 'zod'
import { CODE_LENGTH, isValidLinkCode } from './code.js'
import { MAX_AMOUNT_KOBO, MIN_AMOUNT_KOBO } from './money.js'

/**
 * Reusable field-level schemas. Every request and response schema is built
 * from these so a rule like "an amount is an integer number of kobo between
 * ₦100 and ₦10,000,000" is written once and enforced identically by the API,
 * the web forms and the mobile clients.
 */

/** An integer number of kobo. Never a float, never naira. */
export const KoboSchema = z
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .meta({ id: 'Kobo', description: 'Integer number of kobo (₦1 = 100 kobo). Never a float.' })

/** A chargeable amount for a payment link or a transfer. */
export const AmountKoboSchema = z
  .int()
  .min(MIN_AMOUNT_KOBO)
  .max(MAX_AMOUNT_KOBO)
  .meta({
    id: 'AmountKobo',
    description: `Integer kobo between ${MIN_AMOUNT_KOBO} (₦100) and ${MAX_AMOUNT_KOBO} (₦10,000,000).`,
  })

/** The eight-character short code that identifies a payment link. */
export const LinkCodeSchema = z
  .string()
  .length(CODE_LENGTH)
  .refine(isValidLinkCode, { message: 'not a valid link code' })
  .meta({
    id: 'LinkCode',
    description: `${CODE_LENGTH} characters from an alphabet without 0/O/1/l/I.`,
    pattern: '^[2-9A-HJ-NP-Za-km-z]{8}$',
  })

/** Payment references are user-visible, so they carry a readable prefix. */
export const PaymentReferenceSchema = z
  .string()
  .regex(/^kbl_[2-9A-HJ-NP-Za-km-z]{10}$/, 'not a valid payment reference')
  .meta({ id: 'PaymentReference', description: 'kbl_ followed by ten code characters.' })

/** Opaque, URL-safe identifiers for users, sessions, accounts and postings. */
export const IdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)
  .meta({ id: 'Id', description: 'Opaque URL-safe identifier.' })

export const IsoDateTimeSchema = z
  .iso.datetime({ offset: true })
  .meta({ id: 'IsoDateTime', description: 'RFC 3339 timestamp with offset.' })

export const EmailSchema = z.email().max(254).toLowerCase().trim()

/**
 * Nigerian mobile numbers, normalised to E.164 (+234XXXXXXXXXX). Accepts
 * 0803..., 234803... and +234803... on input.
 */
export const PhoneSchema = z
  .string()
  .trim()
  .transform((raw) => raw.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^(?:\+?234|0)[789][01]\d{8}$/, 'not a Nigerian mobile number'))
  .transform((digits) => {
    if (digits.startsWith('+234')) return digits
    if (digits.startsWith('234')) return `+${digits}`
    return `+234${digits.slice(1)}`
  })
  .meta({ id: 'Phone', description: 'Nigerian mobile number in E.164 form, +234XXXXXXXXXX.' })

export const CurrencySchema = z.literal('NGN').meta({ id: 'Currency' })

/** A human-entered display name: trimmed, never empty, never absurd. */
export const DisplayNameSchema = z.string().trim().min(1).max(80)

/**
 * Idempotency keys are chosen by the client, one per logical attempt. A
 * replayed key returns the original result and never posts twice.
 */
export const IdempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/)
  .meta({
    id: 'IdempotencyKey',
    description: 'Client-chosen key for one logical money-moving attempt. Sent as the Idempotency-Key header.',
  })

export const IDEMPOTENCY_HEADER = 'idempotency-key' as const

/** Cursor pagination: opaque cursors, bounded page sizes. */
export const PageQuerySchema = z.object({
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type PageQuery = z.infer<typeof PageQuerySchema>

export function pageOf<T extends z.ZodType>(item: T, id: string) {
  return z
    .object({
      items: z.array(item),
      nextCursor: z.string().nullable(),
    })
    .meta({ id })
}
