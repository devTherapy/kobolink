import type { INestApplication } from '@nestjs/common'
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js'

/**
 * Everything that must be identical between production (`main.ts`) and the
 * Testcontainers harness (`test/support/api-test-context.ts`) so the two can
 * never quietly diverge — B2's cookie parser and auth guards, B6's SSE
 * response settings, all get added here once, not duplicated in two places.
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api')
  app.useGlobalFilters(new HttpExceptionFilter())
}
