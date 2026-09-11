import { z } from 'zod'
import {
  AmountKoboSchema,
  CurrencySchema,
  DisplayNameSchema,
  IdSchema,
  IsoDateTimeSchema,
  KoboSchema,
  LinkCodeSchema,
  pageOf,
} from './primitives.js'

/**
 * The stored status is only ever `active` or `disabled` — a merchant's
 * deliberate switch. Expiry and single-use exhaustion are *derived* by
 * `resolveLink()` in status.ts, so the database never has to be updated on a
 * clock tick and the four clients cannot disagree about what "expired" means.
 */
export const LinkStatusSchema = z.enum(['active', 'disabled']).meta({ id: 'LinkStatus' })
export type LinkStatus = z.infer<typeof LinkStatusSchema>

export const LinkTitleSchema = z.string().trim().min(1).max(120)
export const LinkDescriptionSchema = z.string().trim().max(500)

/**
 * The merchant's view of a link: everything, including the counters the
 * dashboard shows. Counters are derived server-side from ledger postings;
 * the client never computes them.
 */
export const PaymentLinkSchema = z
  .object({
    code: LinkCodeSchema,
    merchantId: IdSchema,
    merchantName: DisplayNameSchema,
    title: LinkTitleSchema,
    description: LinkDescriptionSchema.nullable(),
    /** null means the payer chooses the amount at checkout. */
    amountKobo: AmountKoboSchema.nullable(),
    currency: CurrencySchema,
    status: LinkStatusSchema,
    isReusable: z.boolean(),
    expiresAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    paymentCount: z.int().min(0),
    totalPaidKobo: KoboSchema,
  })
  .meta({ id: 'PaymentLink' })
export type PaymentLink = z.infer<typeof PaymentLinkSchema>

export const CreateLinkRequestSchema = z
  .object({
    title: LinkTitleSchema,
    description: LinkDescriptionSchema.optional(),
    amountKobo: AmountKoboSchema.nullable().default(null),
    isReusable: z.boolean().default(false),
    expiresAt: IsoDateTimeSchema.nullable().default(null),
  })
  .meta({ id: 'CreateLinkRequest' })
export type CreateLinkRequest = z.infer<typeof CreateLinkRequestSchema>
export type CreateLinkInput = z.input<typeof CreateLinkRequestSchema>

export const UpdateLinkStatusRequestSchema = z
  .object({ status: LinkStatusSchema })
  .meta({ id: 'UpdateLinkStatusRequest' })
export type UpdateLinkStatusRequest = z.infer<typeof UpdateLinkStatusRequestSchema>

export const LinkListResponseSchema = pageOf(PaymentLinkSchema, 'LinkListResponse')
export type LinkListResponse = z.infer<typeof LinkListResponseSchema>

/**
 * The public view served to a stranger by `GET /api/links/:code/public`
 * (`API.links.resolve`). It carries
 * only what the checkout page renders. Nothing private may be added here:
 * no merchant id, no email, no counters beyond what the state needs.
 */
export const PublicLinkSchema = z
  .object({
    code: LinkCodeSchema,
    merchantName: DisplayNameSchema,
    title: LinkTitleSchema,
    description: LinkDescriptionSchema.nullable(),
    amountKobo: AmountKoboSchema.nullable(),
    currency: CurrencySchema,
    isReusable: z.boolean(),
    expiresAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'PublicLink' })
export type PublicLink = z.infer<typeof PublicLinkSchema>

/**
 * What the API tells a stranger about a link. `not-found` is a 404 and is
 * never in a body; the other four are 200s with the state resolved server-side
 * so that the web page and both apps render the same answer.
 */
export const PublicLinkStateSchema = z
  .enum(['payable', 'disabled', 'expired', 'already-paid'])
  .meta({ id: 'PublicLinkState' })
export type PublicLinkState = z.infer<typeof PublicLinkStateSchema>

export const PublicLinkResponseSchema = z
  .object({
    state: PublicLinkStateSchema,
    link: PublicLinkSchema,
  })
  .meta({ id: 'PublicLinkResponse' })
export type PublicLinkResponse = z.infer<typeof PublicLinkResponseSchema>
