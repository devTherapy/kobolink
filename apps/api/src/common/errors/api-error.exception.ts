import { HttpException } from '@nestjs/common'
import { type ApiError, HTTP_STATUS_FOR_ERROR } from '@kobolink/contracts'

/**
 * Throw this anywhere a request cannot be processed for a reason the
 * contract names. `HttpExceptionFilter` recognises the `ApiError`-shaped
 * response body and forwards it verbatim with the status
 * `HTTP_STATUS_FOR_ERROR` assigns to `payload.code` — the single source of
 * truth for the mapping, never duplicated here.
 */
export class ApiErrorException extends HttpException {
  constructor(payload: ApiError) {
    super(payload, HTTP_STATUS_FOR_ERROR[payload.code])
  }
}
