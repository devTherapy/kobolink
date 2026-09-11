import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common'
import {
  IDEMPOTENCY_HEADER,
  IdempotencyKeySchema,
  type InitializeCheckoutRequest,
  InitializeCheckoutRequestSchema,
  type InitializeCheckoutResponse,
  type VerifyCheckoutRequest,
  VerifyCheckoutRequestSchema,
  type VerifyCheckoutResponse,
} from '@kobolink/contracts'
import { ApiErrorException } from '../common/errors/api-error.exception.js'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js'
import { PaymentsService } from './payments.service.js'

/**
 * `/api/checkout/*` (`API.checkout.initialize`/`API.checkout.verify`) —
 * PLAN.md's B5 row. Unauthenticated, like `PublicLinksController` — the
 * checkout page and both mobile apps call this before anyone has signed in
 * — so, same reasoning as that controller's own doc comment, no guard is
 * composed here and this stays its own controller rather than a method
 * grafted onto `LinksController`.
 *
 * The `Idempotency-Key` header is checked *before* the body is parsed
 * against its Zod schema, matching `packages/contracts/README.md`'s "a
 * validation_failed without a key" and the MSW mock's own handler order
 * (`apps/web/src/mocks/handlers.ts`) — a missing key is always the
 * diagnosed problem, never masked by an unrelated body error. That
 * ordering is why `@Body()` here takes no schema of its own: a `ZodValida
 * tionPipe` bound to the parameter runs during Nest's argument resolution,
 * before this method's body (and so before the header check) ever runs;
 * parsing is done by hand, one line later, once the header is known good.
 */
@Controller('checkout')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('initialize')
  @HttpCode(201)
  async initialize(
    @Body() rawBody: unknown,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKeyHeader: string | undefined,
  ): Promise<InitializeCheckoutResponse> {
    const idempotencyKey = this.requireIdempotencyKey(idempotencyKeyHeader)
    const dto = new ZodValidationPipe(InitializeCheckoutRequestSchema).transform(rawBody) as InitializeCheckoutRequest
    return this.paymentsService.initialize(dto, idempotencyKey)
  }

  @Post('verify')
  @HttpCode(200)
  async verify(
    @Body() rawBody: unknown,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKeyHeader: string | undefined,
  ): Promise<VerifyCheckoutResponse> {
    const idempotencyKey = this.requireIdempotencyKey(idempotencyKeyHeader)
    const dto = new ZodValidationPipe(VerifyCheckoutRequestSchema).transform(rawBody) as VerifyCheckoutRequest
    return this.paymentsService.verify(dto, idempotencyKey)
  }

  /** Every money-moving write requires this header; a missing/malformed one is `validation_failed` with `moneyMoved: false`. */
  private requireIdempotencyKey(header: string | undefined): string {
    const parsed = IdempotencyKeySchema.safeParse(header)
    if (!parsed.success) {
      throw new ApiErrorException({
        code: 'validation_failed',
        message: 'Idempotency-Key header is required.',
        moneyMoved: false,
      })
    }
    return parsed.data
  }
}
