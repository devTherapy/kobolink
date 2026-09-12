import { Controller, Get } from '@nestjs/common'
import { buildOpenApiDocument, type OpenApiDocument } from './build-openapi-document.js'

/**
 * `GET /api/openapi.json` — always built fresh from the live
 * `@kobolink/contracts` schemas (`buildOpenApiDocument`), never served from
 * the checked-in `apps/api/openapi.json` file. That file exists for M0's
 * Swift/Kotlin generators to point at without booting the API; this
 * endpoint exists so a runtime consumer (or a human) never has to.
 * `openapi-drift.spec.ts` is what keeps the two copies from disagreeing.
 */
@Controller()
export class OpenApiController {
  @Get('openapi.json')
  get(): OpenApiDocument {
    return buildOpenApiDocument()
  }
}
