import { DrizzleQueryError } from 'drizzle-orm'
import { asPgError } from '../../db/pg-error.js'

/**
 * Review round 1, finding 8: `DrizzleQueryError`'s own message is literally
 * `` `Failed query: ${query}\nparams: ${params}` `` (drizzle-orm's
 * `errors.ts`) — the raw bound parameters, verbatim, in whatever order the
 * query used them. For this app's own queries that routinely means a
 * `token_hash`, a `password_hash`, or a plaintext email landing in a log
 * line. `HttpExceptionFilter` logs the full detail of any *unanticipated*
 * error (anything that reaches it without being an `HttpException`) for
 * diagnosability — this function is what keeps that diagnosability from
 * also being a credential leak.
 *
 * A `DrizzleQueryError` logs only its parameterised SQL text (`$1`, `$2`,
 * ... placeholders, never a bound value) and the Postgres error code /
 * constraint name from its `.cause` (via `asPgError`) — never `.params`.
 * Its own `.stack` is skipped entirely too, since V8 prepends the error's
 * `.message` (params and all) as the stack's first line. Every other error
 * still logs its full stack, unredacted, exactly as before.
 */
export function safeLogDetail(exception: unknown): string {
  if (exception instanceof DrizzleQueryError) {
    const pg = asPgError(exception)
    const parts = [`DrizzleQueryError: ${exception.query}`, `code=${pg?.code ?? 'unknown'}`]
    if (pg?.constraint !== undefined) parts.push(`constraint=${pg.constraint}`)
    parts.push('params=[redacted]')
    return parts.join(' — ')
  }
  if (exception instanceof Error) {
    return exception.stack ?? exception.message
  }
  return String(exception)
}
