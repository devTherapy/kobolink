import { All, Controller, NotFoundException } from '@nestjs/common'

/**
 * Registered last (see `NotFoundModule` and its place at the end of
 * `AppModule`'s `imports`) so every real route gets first refusal. Anything
 * that reaches here is genuinely unmatched. Without this, Express's default
 * final handler answers an unmatched path with an HTML "Cannot GET /..."
 * page instead of the `ApiError` shape every other non-2xx response in this
 * API uses — `HttpExceptionFilter` only ever sees what gets thrown, and
 * nothing throws for a route Express never matched in the first place.
 */
@Controller()
export class NotFoundController {
  // Express 5's path-to-regexp requires a named wildcard, not the bare "*"
  // Express 4 accepted.
  @All('*path')
  handleUnmatched(): never {
    throw new NotFoundException('Not found.')
  }
}
