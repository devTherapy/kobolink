import { HttpException } from '@nestjs/common'
import { type ApiError, type ErrorCode, HTTP_STATUS_FOR_ERROR, isApiError } from '@kobolink/contracts'

/**
 * Best-effort status → code fallback for an `HttpException` whose response
 * body is *not* already an `ApiError` — i.e. one of Nest's own exceptions
 * (`NotFoundException`, a guard's `UnauthorizedException`, ...) rather than
 * one raised through `ApiErrorException`. Several contract codes share an
 * HTTP status (409: `conflict` and `link_not_payable`; 422: `validation_failed`
 * — Nest has no built-in 422 exception — , `amount_mismatch`, `insufficient_funds`),
 * so this table only supplies a *label*; the response status always comes
 * from the exception itself; `HTTP_STATUS_FOR_ERROR` is not consulted for
 * these, because guessing the wrong one of several codes that share a status
 * must never also guess the wrong status.
 */
const STATUS_TO_ERROR_CODE: Readonly<Record<number, ErrorCode>> = {
  400: 'validation_failed',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  422: 'validation_failed',
  429: 'rate_limited',
}

function extractMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'string') return payload
  if (payload !== null && typeof payload === 'object' && 'message' in payload) {
    const { message } = payload
    if (typeof message === 'string') return message
    if (Array.isArray(message) && message.every((part) => typeof part === 'string')) {
      return message.join(' ')
    }
  }
  return fallback
}

/**
 * Pure mapping from anything `catch (exception)` can hand a global filter to
 * the `{ status, body: ApiError }` the contract requires every non-2xx
 * response to carry. No I/O — `HttpExceptionFilter` is the thin Nest
 * adapter around this that actually writes the response and logs the
 * unexpected case.
 */
export function toApiErrorResponse(exception: unknown): { status: number; body: ApiError } {
  if (exception instanceof HttpException) {
    const payload = exception.getResponse()
    if (isApiError(payload)) {
      return { status: HTTP_STATUS_FOR_ERROR[payload.code], body: payload }
    }

    const status = exception.getStatus()
    const code = STATUS_TO_ERROR_CODE[status] ?? 'internal'
    return { status, body: { code, message: extractMessage(payload, exception.message) } }
  }

  return {
    status: HTTP_STATUS_FOR_ERROR.internal,
    body: { code: 'internal', message: 'Internal server error.' },
  }
}
