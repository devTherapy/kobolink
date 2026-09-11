import { All, Controller, NotFoundException } from '@nestjs/common'

/**
 * Registered last (see `NotFoundModule` and its place at the end of
 * `AppModule`'s `imports`) so every real route gets first refusal. Without
 * this, Express's own default final handler answers an unmatched request
 * with an HTML "Cannot GET /..." page instead of the `ApiError` shape every
 * other non-2xx response in this API uses — Nest does not itself convert an
 * unmatched route into a `NotFoundException`; nothing throws unless
 * something here does.
 *
 * Two routes, not one: `@All('*path')` matches any method against any path
 * with at least one segment following the global `/api` prefix (it also
 * covers a real path with the wrong method, e.g. `DELETE /api/health` —
 * `@All` matches every verb). It does **not** match the bare `/api` or
 * `/api/` — path-to-regexp's `{*path}` wildcard requires a following
 * segment — so `@All()` (the controller's own empty path) exists
 * specifically to cover those two.
 */
@Controller()
export class NotFoundController {
  @All()
  handleRoot(): never {
    throw new NotFoundException('Not found.')
  }

  @All('*path')
  handleUnmatched(): never {
    throw new NotFoundException('Not found.')
  }
}
