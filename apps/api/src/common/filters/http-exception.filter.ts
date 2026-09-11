import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common'
import type { Response } from 'express'
import { toApiErrorResponse } from './error-mapping.js'

/**
 * Registered globally in `main.ts`. Every thrown error — ours or Nest's own
 * — leaves this process as an `ApiError` body with the status
 * `HTTP_STATUS_FOR_ERROR` names, never a framework-default HTML page or a
 * bare stack trace. `toApiErrorResponse` does the mapping; this class is
 * only the Nest/Express plumbing and the log line for the case that was not
 * anticipated.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const { status, body } = toApiErrorResponse(exception)

    if (body.code === 'internal') {
      const detail = exception instanceof Error ? (exception.stack ?? exception.message) : String(exception)
      this.logger.error(detail)
    }

    const response = host.switchToHttp().getResponse<Response>()
    response.status(status).json(body)
  }
}
