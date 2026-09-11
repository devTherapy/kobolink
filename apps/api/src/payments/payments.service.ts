import { Injectable } from '@nestjs/common'
import {
  API,
  type ApiError,
  HTTP_STATUS_FOR_ERROR,
  type InitializeCheckoutRequest,
  type InitializeCheckoutResponse,
  InitializeCheckoutResponseSchema,
  isSimulatedDecline,
  type LedgerAccountKind,
  maskEmail,
  newPaymentReference,
  resolveLink,
  toPublicLinkState,
  type VerifyCheckoutRequest,
  type VerifyCheckoutResponse,
  VerifyCheckoutResponseSchema,
} from '@kobolink/contracts'
import { and, eq } from 'drizzle-orm'
import { ApiErrorException } from '../common/errors/api-error.exception.js'
import { IdempotencyService } from '../common/idempotency/idempotency.service.js'
import type { DbTransaction } from '../db/db.service.js'
import { isUniqueViolation } from '../db/pg-error.js'
import * as schema from '../db/schema/index.js'
import { LinksService } from '../links/links.service.js'
import { rowToPayment, type PostingLinkPaymentMetadata } from './payment-mapper.js'

/** `checkout_sessions.reference` is the primary key; a collision is this constraint firing on insert. */
const CHECKOUT_SESSIONS_PKEY_CONSTRAINT = 'checkout_sessions_pkey'
/** Same reasoning as `LinksService`'s `MAX_CODE_ATTEMPTS` — bounds a vanishingly unlikely retry loop, nothing more. */
const MAX_REFERENCE_ATTEMPTS = 8

interface DecideResult<T> {
  status: number
  body: T | ApiError
}

/**
 * `POST /api/checkout/initialize` and `POST /api/checkout/verify`
 * (`PaymentsController`) — PLAN.md's B5 row, the only place in `apps/api`
 * that ever writes a `postings`/`ledger_entries` row for a `link_payment`.
 *
 * The two-call shape (`packages/contracts/README.md`'s "mirrors Paystack's
 * shape deliberately") means the *decision* — re-resolving the link, the
 * simulated gateway's decline check, and the resulting posting — happens
 * entirely inside `verify`, never `initialize`; see
 * `db/schema/checkout-sessions.ts`'s doc comment for why `initialize`
 * cannot instead create the eventual posting early and have `verify` fill
 * it in (`ledger_entries_posting_same_transaction` forbids exactly that).
 *
 * Both methods are wrapped in `IdempotencyService.run`, which itself wraps
 * `compute` in one DB transaction together with the `idempotency_keys`
 * insert — so every write below (`checkout_sessions`, `postings`,
 * `ledger_entries`) either lands with that insert or not at all.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly linksService: LinksService,
  ) {}

  async initialize(dto: InitializeCheckoutRequest, idempotencyKey: string): Promise<InitializeCheckoutResponse> {
    const outcome = await this.idempotency.run(API.checkout.initialize, idempotencyKey, dto, (tx) =>
      this.decideInitialize(tx, dto),
    )
    return this.unwrap(outcome)
  }

  async verify(dto: VerifyCheckoutRequest, idempotencyKey: string): Promise<VerifyCheckoutResponse> {
    const outcome = await this.idempotency.run(API.checkout.verify, idempotencyKey, dto, (tx) =>
      this.decideVerify(tx, dto, idempotencyKey),
    )
    return this.unwrap(outcome)
  }

  /** A stored/computed `{status, body}` below 400 is the real response; 400+ is always `ApiError` and must surface as one. */
  private unwrap<T>(outcome: { status: number; body: T | ApiError }): T {
    if (outcome.status >= 400) throw new ApiErrorException(outcome.body as ApiError)
    return outcome.body as T
  }

  private async decideInitialize(
    tx: DbTransaction,
    dto: InitializeCheckoutRequest,
  ): Promise<DecideResult<InitializeCheckoutResponse>> {
    const resolved = await this.linksService.getForCheckout(tx, dto.code)
    if (resolved === undefined) {
      return this.errorResult('not_found', 'No link with that code.')
    }

    const resolution = resolveLink(resolved.link)
    if (resolution.kind !== 'payable') {
      return this.errorResult('link_not_payable', 'This link cannot be paid right now.', {
        state: toPublicLinkState(resolution) ?? undefined,
      })
    }

    if (resolved.link.amountKobo !== null && resolved.link.amountKobo !== dto.amountKobo) {
      return this.errorResult('amount_mismatch', 'That amount does not match this link.')
    }

    const reference = await this.insertCheckoutSession(tx, {
      linkCode: resolved.link.code,
      amountKobo: dto.amountKobo,
      payerName: dto.payerName,
      payerEmail: dto.payerEmail,
    })

    const body = InitializeCheckoutResponseSchema.parse({
      reference,
      code: resolved.link.code,
      amountKobo: dto.amountKobo,
      currency: 'NGN',
      status: 'pending',
      createdAt: new Date().toISOString(),
    })
    return { status: 201, body }
  }

  private async decideVerify(
    tx: DbTransaction,
    dto: VerifyCheckoutRequest,
    idempotencyKey: string,
  ): Promise<DecideResult<VerifyCheckoutResponse>> {
    // Locks this reference's row for the rest of the transaction: a second,
    // concurrent `verify` for the *same* reference (any Idempotency-Key —
    // README: "verifying the same reference again, under any key, returns
    // the original payment; a reference is decided once") blocks here until
    // this transaction commits or rolls back, then re-reads the fresh row
    // instead of racing to decide the same reference twice.
    const [session] = await tx
      .select()
      .from(schema.checkoutSessions)
      .where(eq(schema.checkoutSessions.reference, dto.reference))
      .for('update')
    if (session === undefined) {
      return this.errorResult('not_found', 'No checkout with that reference.')
    }

    if (session.postingId !== null) {
      const payment = await this.loadDecidedPayment(tx, session.postingId)
      return { status: 200, body: VerifyCheckoutResponseSchema.parse({ payment }) }
    }

    // Locks the *link* row too: a single-use link paid by a racing
    // `initialize`/`verify` pair (two different references, the same link)
    // must not let both transactions see `paymentCount === 0` and both
    // decide "payable" — this serialises them so the second sees the
    // first's now-committed posting via `getForCheckout`'s own stats read.
    await tx.select({ code: schema.links.code }).from(schema.links).where(eq(schema.links.code, session.linkCode)).for('update')

    const resolved = await this.linksService.getForCheckout(tx, session.linkCode)
    if (resolved === undefined) {
      throw new Error(`payments: checkout_sessions.link_code ${session.linkCode} does not reference an existing link`)
    }
    const resolution = resolveLink(resolved.link)

    let status: 'success' | 'failed'
    let failureReason: string | null
    if (resolution.kind !== 'payable') {
      status = 'failed'
      failureReason = this.notPayableReason(resolution.kind)
    } else if (isSimulatedDecline(session.payerEmail)) {
      status = 'failed'
      failureReason = 'Card declined by the simulated gateway.'
    } else {
      status = 'success'
      failureReason = null
    }

    const metadata: PostingLinkPaymentMetadata = {
      linkCode: session.linkCode,
      amountKobo: session.amountKobo,
      payerName: session.payerName,
      payerEmail: maskEmail(session.payerEmail),
      status,
      failureReason,
    }

    const [postingRow] = await tx
      .insert(schema.postings)
      .values({
        kind: 'link_payment',
        reference: dto.reference,
        idempotencyScope: API.checkout.verify,
        idempotencyKey,
        metadata,
      })
      .returning()
    if (postingRow === undefined) throw new Error('payments: posting insert returned no row')

    if (status === 'success') {
      const merchantAccount = await this.getOrCreateAccount(tx, 'merchant_receivable', resolved.merchantUserId)
      const externalAccount = await this.getOrCreateAccount(tx, 'external_funding', null)
      await tx.insert(schema.ledgerEntries).values([
        { postingId: postingRow.id, accountId: externalAccount.id, amountKobo: -session.amountKobo },
        { postingId: postingRow.id, accountId: merchantAccount.id, amountKobo: session.amountKobo },
      ])
    }

    await tx
      .update(schema.checkoutSessions)
      .set({ postingId: postingRow.id })
      .where(eq(schema.checkoutSessions.reference, session.reference))

    const payment = rowToPayment(postingRow)
    return { status: 200, body: VerifyCheckoutResponseSchema.parse({ payment }) }
  }

  private async loadDecidedPayment(tx: DbTransaction, postingId: string) {
    const [postingRow] = await tx.select().from(schema.postings).where(eq(schema.postings.id, postingId)).limit(1)
    if (postingRow === undefined) {
      throw new Error(`payments: checkout_sessions.posting_id ${postingId} does not reference an existing posting`)
    }
    return rowToPayment(postingRow)
  }

  private notPayableReason(kind: 'not-found' | 'disabled' | 'expired' | 'already-paid'): string {
    switch (kind) {
      case 'disabled':
        return 'Link is disabled'
      case 'expired':
        return 'Link has expired'
      case 'already-paid':
        return 'Link is already paid'
      case 'not-found':
        return 'Link no longer exists'
    }
  }

  private async insertCheckoutSession(
    tx: DbTransaction,
    session: { linkCode: string; amountKobo: number; payerName: string; payerEmail: string },
  ): Promise<string> {
    for (let attempt = 0; attempt < MAX_REFERENCE_ATTEMPTS; attempt++) {
      const reference = newPaymentReference()
      try {
        await tx.insert(schema.checkoutSessions).values({ reference, ...session })
        return reference
      } catch (error) {
        if (isUniqueViolation(error, CHECKOUT_SESSIONS_PKEY_CONSTRAINT)) continue
        throw error
      }
    }
    throw new ApiErrorException({ code: 'conflict', message: 'Could not allocate a unique payment reference. Try again.' })
  }

  /**
   * Get-or-create for a `ledger_accounts` row. `merchant_receivable` is
   * looked up (and, the first time this merchant is ever paid, created) by
   * `(kind, ownerUserId)`; `external_funding` — the simulated gateway's
   * singleton source/sink, `ownerUserId: null` — by `kind` alone. Either
   * unique index can still lose a create race to a concurrent transaction;
   * the catch re-reads and returns the winner's row rather than erroring.
   */
  private async getOrCreateAccount(
    tx: DbTransaction,
    kind: LedgerAccountKind,
    ownerUserId: string | null,
  ): Promise<{ id: string }> {
    const existing = await this.findAccount(tx, kind, ownerUserId)
    if (existing !== undefined) return existing

    try {
      const [row] = await tx.insert(schema.ledgerAccounts).values({ kind, ownerUserId }).returning({ id: schema.ledgerAccounts.id })
      if (row === undefined) throw new Error('payments: ledger account insert returned no row')
      return row
    } catch (error) {
      const constraint = ownerUserId === null ? 'ledger_accounts_external_funding_singleton' : 'ledger_accounts_owner_kind_unique'
      if (isUniqueViolation(error, constraint)) {
        const raced = await this.findAccount(tx, kind, ownerUserId)
        if (raced !== undefined) return raced
      }
      throw error
    }
  }

  private async findAccount(tx: DbTransaction, kind: LedgerAccountKind, ownerUserId: string | null): Promise<{ id: string } | undefined> {
    const where =
      ownerUserId === null
        ? eq(schema.ledgerAccounts.kind, kind)
        : and(eq(schema.ledgerAccounts.kind, kind), eq(schema.ledgerAccounts.ownerUserId, ownerUserId))
    const [row] = await tx.select({ id: schema.ledgerAccounts.id }).from(schema.ledgerAccounts).where(where).limit(1)
    return row
  }

  private errorResult<T>(code: ApiError['code'], message: string, extra: Partial<ApiError> = {}): DecideResult<T> {
    const body: ApiError = { code, message, moneyMoved: false, ...extra }
    return { status: HTTP_STATUS_FOR_ERROR[code], body }
  }
}
