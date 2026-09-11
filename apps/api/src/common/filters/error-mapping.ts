import { HttpException } from '@nestjs/common'
import { type ApiError, ApiErrorSchema, type ErrorCode, ErrorCodeSchema, HTTP_STATUS_FOR_ERROR } from '@kobolink/contracts'
import { ApiErrorException } from '../errors/api-error.exception.js'

/** Minimal logging surface `toApiErrorResponse` needs; Nest's `Logger` satisfies it. */
export interface ErrorMappingLogger {
  error: (message: string) => void
}

/**
 * Best-effort status → code fallback for an `HttpException` that did *not*
 * come from `ApiErrorException` — one of Nest's own (`NotFoundException`, a
 * guard's `UnauthorizedException`, ...) or a plain error with a numeric
 * `status`/`statusCode` (Express body-parser's malformed-JSON 400 or
 * payload-too-large 413). Several contract codes share an HTTP status (409:
 * `conflict` and `link_not_payable`; 422: `idempotency_mismatch`,
 * `amount_mismatch`, `insufficient_funds`), and several real statuses have
 * no contract code at all (405, 413, 415, 503, ...), so this table only ever
 * supplies a best-effort *label*. The response's actual HTTP status always
 * comes from the exception itself, never from `HTTP_STATUS_FOR_ERROR[code]`
 * — otherwise a status with no single exact owner would silently change on
 * the wire to whatever this table's guess happens to canonically map to.
 */
const STATUS_TO_ERROR_CODE: Readonly<Record<number, ErrorCode>> = {
  400: 'validation_failed',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  // Nest's UnprocessableEntityException (or anything else that reaches for
  // a bare 422) has no way to say *which* 422 it means; an unshaped
  // idempotency conflict is the most common bare 422 this API raises.
  422: 'idempotency_mismatch',
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
 * A well-formed HTTP status carried on something that is not a Nest
 * `HttpException` at all — most commonly Express middleware ahead of Nest
 * (body-parser) throwing a plain `Error` with a `status`/`statusCode`
 * property, the convention the `http-errors` package (and body-parser
 * itself) uses.
 */
function extractPlainStatus(exception: unknown): number | undefined {
  if (exception === null || typeof exception !== 'object') return undefined
  const candidate =
    'status' in exception ? exception.status : 'statusCode' in exception ? exception.statusCode : undefined
  if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599) {
    return candidate
  }
  return undefined
}

/**
 * Recovers a safe `ApiError` from an `ApiErrorException` payload that failed
 * `ApiErrorSchema` (see `toApiErrorResponse`) — only `code` and `message`
 * are trusted, since those are the fields a failed refinement (e.g.
 * `link_not_payable` paired with `state: 'payable'`) is least likely to
 * have corrupted, and `code` is what the status must stay consistent with.
 */
function salvageApiError(payload: unknown, status: number): ApiError {
  if (payload !== null && typeof payload === 'object' && 'code' in payload && 'message' in payload) {
    const code = ErrorCodeSchema.safeParse(payload.code)
    const { message } = payload
    if (code.success && typeof message === 'string') {
      return { code: code.data, message }
    }
  }
  return { code: 'internal', message: status >= 500 ? 'Internal server error.' : 'Request could not be processed.' }
}

/**
 * Mapping from anything `catch (exception)` can hand a global filter to the
 * `{ status, body: ApiError }` the contract requires every non-2xx response
 * to carry. The only side effect is the optional `logger.error` call for
 * the one case that must never pass silently: our own code constructing an
 * `ApiErrorException` whose payload does not satisfy the contract's own
 * schema. `HttpExceptionFilter` is the thin Nest adapter that writes the
 * response and supplies the real logger; tests pass a spy or nothing.
 */
export function toApiErrorResponse(
  exception: unknown,
  logger?: ErrorMappingLogger,
): { status: number; body: ApiError } {
  if (exception instanceof ApiErrorException) {
    const payload = exception.getResponse()
    const parsed = ApiErrorSchema.safeParse(payload)
    if (parsed.success) {
      // Forward the *parsed* data (unknown keys stripped by zod), not the
      // raw payload — `code` is what decides the status, so this and
      // `exception.getStatus()` (computed from the same field at
      // construction time) always agree.
      return { status: HTTP_STATUS_FOR_ERROR[parsed.data.code], body: parsed.data }
    }
    // A bug on our side: something built an ApiErrorException whose payload
    // does not satisfy the contract's own schema. That must never pass
    // un-diagnosed, but the request still gets an answer.
    logger?.error(
      `ApiErrorException payload failed ApiErrorSchema: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    )
    const status = exception.getStatus()
    return { status, body: salvageApiError(payload, status) }
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus()
    const code = STATUS_TO_ERROR_CODE[status] ?? 'internal'
    // A 5xx from a bare HttpException (e.g. `new InternalServerErrorException(driverError.message)`)
    // must never forward driver/internal detail to a client.
    const message = status >= 500 ? 'Internal server error.' : extractMessage(exception.getResponse(), exception.message)
    return { status, body: { code, message } }
  }

  const plainStatus = extractPlainStatus(exception)
  if (plainStatus !== undefined) {
    const code = STATUS_TO_ERROR_CODE[plainStatus] ?? 'internal'
    const rawMessage = exception instanceof Error ? exception.message : undefined
    const message = plainStatus >= 500 ? 'Internal server error.' : (rawMessage ?? 'Request could not be processed.')
    return { status: plainStatus, body: { code, message } }
  }

  return {
    status: HTTP_STATUS_FOR_ERROR.internal,
    body: { code: 'internal', message: 'Internal server error.' },
  }
}
