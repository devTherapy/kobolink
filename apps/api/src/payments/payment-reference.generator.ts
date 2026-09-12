import { newPaymentReference } from '@kobolink/contracts'

/**
 * A reference generator as a pure function type, injected via
 * `PAYMENT_REFERENCE_GENERATOR` rather than `PaymentsService` importing
 * `newPaymentReference` directly — the same seam `LinksModule`'s
 * `LINK_CODE_GENERATOR` gives `LinksService.create` (see that file's own doc
 * comment). This is the seam a concurrency test uses to force a genuine
 * `checkout_sessions_pkey` collision (a queued, already-taken reference
 * handed out on purpose) without narrowing `newPaymentReference`'s real
 * alphabet/length or relying on chance — see
 * `test/checkout-initialize-concurrency.integration.test.ts`.
 */
export type PaymentReferenceGenerator = () => string

export const PAYMENT_REFERENCE_GENERATOR = Symbol('PAYMENT_REFERENCE_GENERATOR')

/** The real generator — `packages/contracts`' `kbl_...` reference shape. */
export const defaultPaymentReferenceGenerator: PaymentReferenceGenerator = newPaymentReference
