import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import {
  type CreateLinkRequest,
  CreateLinkRequestSchema,
  type LinkListResponse,
  type PageQuery,
  PageQuerySchema,
  type PaymentLink,
  type PaymentListResponse,
  type UpdateLinkStatusRequest,
  UpdateLinkStatusRequestSchema,
  type User,
} from '@kobolink/contracts'
import { MerchantGuard } from '../auth/merchant.guard.js'
import { SessionGuard } from '../auth/session.guard.js'
import { CurrentUser } from '../auth/current-user.decorator.js'
import { ApiErrorException } from '../common/errors/api-error.exception.js'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js'
import { LinkCodeParamPipe } from './link-code.pipe.js'
import { LinksService } from './links.service.js'

const NOT_FOUND_MESSAGE = 'Link not found.'

/**
 * `/api/links*` — PLAN.md's B3 row. Every route is a merchant's own links:
 * `@UseGuards(SessionGuard, MerchantGuard)` at the controller level, so a
 * missing/invalid credential is `unauthenticated` 401 and an authenticated
 * customer is `forbidden` 403 before any handler runs (`MerchantGuard`'s own
 * doc comment). `LinksService` owns every other decision — this class is
 * only the HTTP/validation adapter, matching `AuthController`'s shape.
 */
@Controller('links')
@UseGuards(SessionGuard, MerchantGuard)
export class LinksController {
  constructor(private readonly linksService: LinksService) {}

  @Post()
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(CreateLinkRequestSchema)) dto: CreateLinkRequest,
    @CurrentUser() user: User,
  ): Promise<PaymentLink> {
    return this.linksService.create(user, dto)
  }

  @Get()
  async list(
    @Query(new ZodValidationPipe(PageQuerySchema)) query: PageQuery,
    @CurrentUser() user: User,
  ): Promise<LinkListResponse> {
    return this.linksService.list(user, query)
  }

  @Get(':code')
  async get(@Param('code', new LinkCodeParamPipe()) code: string, @CurrentUser() user: User): Promise<PaymentLink> {
    const link = await this.linksService.getByCode(user, code)
    return this.orNotFound(link)
  }

  @Patch(':code/status')
  async updateStatus(
    @Param('code', new LinkCodeParamPipe()) code: string,
    @Body(new ZodValidationPipe(UpdateLinkStatusRequestSchema)) dto: UpdateLinkStatusRequest,
    @CurrentUser() user: User,
  ): Promise<PaymentLink> {
    const link = await this.linksService.updateStatus(user, code, dto.status)
    return this.orNotFound(link)
  }

  @Get(':code/payments')
  async payments(
    @Param('code', new LinkCodeParamPipe()) code: string,
    @Query(new ZodValidationPipe(PageQuerySchema)) query: PageQuery,
    @CurrentUser() user: User,
  ): Promise<PaymentListResponse> {
    const page = await this.linksService.payments(user, code, query)
    return this.orNotFound(page)
  }

  /** `not_found` — a malformed code (`LinkCodeParamPipe`), an unknown one, and another merchant's are indistinguishable, on purpose. */
  private orNotFound<T>(value: T | undefined): T {
    if (value === undefined) {
      throw new ApiErrorException({ code: 'not_found', message: NOT_FOUND_MESSAGE })
    }
    return value
  }
}
