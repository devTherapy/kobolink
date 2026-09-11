import { z } from 'zod'
import { PublicLinkStateSchema } from './links.js'

/**
 * Every non-2xx response has this body. `code` is stable and machine-readable;
 * `message` is for people. `fields` carries validation problems keyed by the
 * request field so a form can show the error beside the input.
 */
export const ErrorCodeSchema = z
  .enum([
    'validation_failed',
    'unauthenticated',
    'forbidden',
    'not_found',
    'conflict',
    'rate_limited',
    'idempotency_mismatch',
    'link_not_payable',
    'amount_mismatch',
    'insufficient_funds',
    'internal',
  ])
  .meta({ id: 'ErrorCode' })
export type ErrorCode = z.infer<typeof ErrorCodeSchema>

export const ApiErrorSchema = z
  .object({
    code: ErrorCodeSchema,
    message: z.string().min(1),
    fields: z.record(z.string(), z.array(z.string().min(1))).optional(),
    /** Only on money-moving failures: did any money move? Always answered. */
    moneyMoved: z.boolean().optional(),
    /**
     * Only on `link_not_payable`: the state the link resolved to, so a client
     * that loaded a payable link and lost the race can show the right screen.
     */
    state: PublicLinkStateSchema.optional(),
  })
  .meta({ id: 'ApiError' })
export type ApiError = z.infer<typeof ApiErrorSchema>

export const HTTP_STATUS_FOR_ERROR: Readonly<Record<ErrorCode, number>> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  idempotency_mismatch: 422,
  link_not_payable: 409,
  amount_mismatch: 422,
  insufficient_funds: 422,
  internal: 500,
}

export function isApiError(value: unknown): value is ApiError {
  return ApiErrorSchema.safeParse(value).success
}
