import { Body, Controller, Get, Headers, HttpCode, Post, Query, UseGuards } from '@nestjs/common'
import {
  IDEMPOTENCY_HEADER,
  IdempotencyKeySchema,
  type PageQuery,
  PageQuerySchema,
  type TopUpRequest,
  TopUpRequestSchema,
  type TransferRequest,
  TransferRequestSchema,
  type TransferResponse,
  type User,
  type Wallet,
  type WalletTransactionListResponse,
} from '@kobolink/contracts'
import { CurrentUser } from '../auth/current-user.decorator.js'
import { SessionGuard } from '../auth/session.guard.js'
import { ApiErrorException } from '../common/errors/api-error.exception.js'
import { DbService } from '../db/db.service.js'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js'
import { WalletService } from './wallet.service.js'

/**
 * `/api/wallet*` — PLAN.md's B8 row, Phase 2. Every route is behind
 * `@UseGuards(SessionGuard)` only, never `MerchantGuard`: a wallet belongs
 * to any signed-in user, merchant or customer alike — "a customer paying by
 * QR and a merchant collecting are the same entity with different
 * capabilities", never a second table, matching `db/schema/users.ts`'s own
 * framing.
 *
 * Same `Idempotency-Key`-before-body-parsing discipline as
 * `PaymentsController`: the header is checked first so a missing key is
 * always the diagnosed problem, never masked by an unrelated body error.
 */
@Controller('wallet')
@UseGuards(SessionGuard)
export class WalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly db: DbService,
  ) {}

  @Get()
  async getWallet(@CurrentUser() user: User): Promise<Wallet> {
    return this.walletService.getWallet(this.db.db, user)
  }

  @Get('transactions')
  async transactions(
    @Query(new ZodValidationPipe(PageQuerySchema)) query: PageQuery,
    @CurrentUser() user: User,
  ): Promise<WalletTransactionListResponse> {
    return this.walletService.transactions(this.db.db, user, query)
  }

  @Post('transfer')
  @HttpCode(201)
  async transfer(
    @Body() rawBody: unknown,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKeyHeader: string | undefined,
    @CurrentUser() user: User,
  ): Promise<TransferResponse> {
    const idempotencyKey = this.requireIdempotencyKey(idempotencyKeyHeader)
    const dto = new ZodValidationPipe(TransferRequestSchema).transform(rawBody) as TransferRequest
    return this.walletService.transfer(dto, user, idempotencyKey)
  }

  @Post('topup')
  @HttpCode(201)
  async topup(
    @Body() rawBody: unknown,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKeyHeader: string | undefined,
    @CurrentUser() user: User,
  ): Promise<TransferResponse> {
    const idempotencyKey = this.requireIdempotencyKey(idempotencyKeyHeader)
    const dto = new ZodValidationPipe(TopUpRequestSchema).transform(rawBody) as TopUpRequest
    return this.walletService.topup(dto, user, idempotencyKey)
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
