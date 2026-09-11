import { HttpException, type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common'
import type { Response } from 'express'
import { toApiErrorResponse } from './error-mapping.js'

/**
 * Registered globally in `main.ts`. Every thrown error — ours or Nest's own
 * — leaves this process as an `ApiError` body with the status
 * `HTTP_STATUS_FOR_ERROR` names, never a framework-default HTML page or a
 * bare stack trace. `toApiErrorResponse` does the mapping; this class is
 * only the Nest/Express plumbing, the full-stack log for the case that was
 * genuinely not anticipated, and the `ApiErrorException`-schema-violation
 * log `toApiErrorResponse` itself triggers via the logger it is handed.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const { status, body } = toApiErrorResponse(exception, this.logger)

    // An `HttpException` — ours or Nest's own — is always an anticipated,
    // understood condition, even when it has no precise contract code and
    // therefore reports `code: 'internal'` (an unshaped 503, say). Reserve
    // the full-stack ERROR log for what actually is unanticipated: anything
    // that reached here *without* being an HttpException at all.
    if (!(exception instanceof HttpException)) {
      const detail = exception instanceof Error ? (exception.stack ?? exception.message) : String(exception)
      this.logger.error(detail)
    }

    const response = host.switchToHttp().getResponse<Response>()
    // A response already in flight (most relevantly, B6's SSE stream) can't
    // have its status/headers rewritten — writing to it here would throw
    // ERR_HTTP_HEADERS_SENT out of the filter itself.
    if (response.headersSent) return
    response.status(status).json(body)
  }
}
