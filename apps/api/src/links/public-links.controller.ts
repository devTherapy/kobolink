import { Controller, Get, Param } from '@nestjs/common'
import { type PublicLinkResponse } from '@kobolink/contracts'
import { ApiErrorException } from '../common/errors/api-error.exception.js'
import { LinkCodeParamPipe } from './link-code.pipe.js'
import { LinksService } from './links.service.js'

const NOT_FOUND_MESSAGE = 'Link not found.'

/**
 * `GET /api/links/:code/public` (`API.links.resolve`) — PLAN.md's B4 row.
 * Deliberately its own controller, not another method on `LinksController`:
 * that class carries `@UseGuards(SessionGuard, MerchantGuard)` at the class
 * level for every route it declares, and Nest has no per-method way to lift a
 * class-level guard back off — the only reliable way to keep this route
 * reachable by a stranger with no session at all (the public checkout page,
 * F6, and both mobile apps all call it before anyone has signed in) is to
 * never put it in that class. No guard is composed here, on purpose; if a
 * future edit ever adds one to this controller, that is a regression, not a
 * hardening — see `public-link-resolution.integration.test.ts`'s guard
 * against exactly that.
 *
 * The response is `PublicLinkResponse` (`state` + a `PublicLink`), never
 * `PaymentLink` — `LinksService.resolvePublic` is what strips the fields a
 * stranger has no business seeing (merchant id, raw `status`, the payment
 * counters) before this ever reaches the wire.
 */
@Controller('links')
export class PublicLinksController {
  constructor(private readonly linksService: LinksService) {}

  @Get(':code/public')
  async resolve(@Param('code', new LinkCodeParamPipe()) code: string): Promise<PublicLinkResponse> {
    const response = await this.linksService.resolvePublic(code)
    if (response === undefined) {
      throw new ApiErrorException({ code: 'not_found', message: NOT_FOUND_MESSAGE })
    }
    return response
  }
}
