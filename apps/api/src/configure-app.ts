import type { INestApplication } from '@nestjs/common'
import cookieParser from 'cookie-parser'
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js'

/**
 * Everything that must be identical between production (`main.ts`) and the
 * Testcontainers harness (`test/support/api-test-context.ts`) so the two can
 * never quietly diverge — B2's cookie parser and auth guards, B6's SSE
 * response settings, all get added here once, not duplicated in two places.
 *
 * `cookieParser()` runs unsigned (no secret) — `SessionGuard`/`extractToken`
 * read `req.cookies[SESSION_COOKIE_NAME]` as a plain opaque token and look it
 * up by its sha256 digest server-side; a forged or tampered cookie value
 * just fails that lookup, so a signed-cookie layer would add nothing here.
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api')
  app.use(cookieParser())
  app.useGlobalFilters(new HttpExceptionFilter())
}
