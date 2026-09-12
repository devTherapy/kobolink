import { Inject, Injectable } from '@nestjs/common'
import {
  type ApiError,
  HTTP_STATUS_FOR_ERROR,
  type PageQuery,
  type TopUpRequest,
  type TransferRequest,
  type TransferResponse,
  TransferResponseSchema,
  type User,
  type Wallet,
  WalletSchema,
  type WalletTransactionListResponse,
} from '@kobolink/contracts'
import { and, desc, eq, inArray, lt, or, type SQL, sql } from 'drizzle-orm'
import { getOrCreateLedgerAccount, findLedgerAccount } from '../common/ledger/ledger-accounts.js'
import { ApiErrorException } from '../common/errors/api-error.exception.js'
import { IdempotencyService } from '../common/idempotency/idempotency.service.js'
import type { Database, DbTransaction } from '../db/db.service.js'
import { toIso } from '../db/iso-timestamp.js'
import { isUniqueViolation } from '../db/pg-error.js'
import * as schema from '../db/schema/index.js'
import { computeWalletBalance } from './wallet-balance.js'
import { decodeWalletCursor, encodeWalletCursor } from './wallet-cursor.js'
import { rowToWalletTransaction, type PostingWalletMetadata } from './wallet-mapper.js'
import { WALLET_REFERENCE_GENERATOR, type WalletReferenceGenerator } from './wallet-reference.generator.js'

/** `postings.reference` unique index — a wallet reference collision (astronomically unlikely) is this constraint firing. */
const POSTINGS_REFERENCE_UNIQUE_CONSTRAINT = 'postings_reference_unique'
/** `postings`' `(idempotency_scope, idempotency_key)` unique index — same reasoning as `PaymentsService`'s own copy of this constant. */
const POSTINGS_IDEMPOTENCY_SCOPE_KEY_CONSTRAINT = 'postings_idempotency_scope_key_unique'
/** Bounds a vanishingly unlikely retry loop — same reasoning as `LinksService`'s `MAX_CODE_ATTEMPTS`. */
const MAX_REFERENCE_ATTEMPTS = 8

interface DecideResult<T> {
  status: number
  body: T | ApiError
}

/**
 * `GET /api/wallet`, `GET /api/wallet/transactions`, `POST
 * /api/wallet/transfer`, `POST /api/wallet/topup` (`WalletController`) —
 * PLAN.md's B8 row, Phase 2. A wallet is just another `ledger_accounts.kind`
 * (`kind: 'wallet'`) and a transfer/top-up is just another posting pair —
 * no new table, exactly `db/schema/ledger-accounts.ts`'s own doc comment.
 *
 * Every money-moving method here goes through `IdempotencyService.run`
 * scoped to the *authenticated user's own id* — `postings.ts`'s own doc
 * comment anticipates this exactly ("`scope` is the authenticated user id
 * for wallet endpoints, the endpoint path for unauthenticated checkout"):
 * unlike B5's unauthenticated checkout, a wallet write always has a caller,
 * so scoping by that caller's id (rather than the shared endpoint path)
 * means two different users can never collide on the same client-chosen
 * `Idempotency-Key` by coincidence.
 *
 * Concurrency-safety for `transfer`'s "insufficient funds" check follows
 * `PaymentsService.decideVerify`'s own playbook: `SELECT ... FOR UPDATE` on
 * the sender's `ledger_accounts` row serialises concurrent transfers *from
 * the same sender* (the only account whose balance this ever needs to
 * protect — a credit never needs to be refused, so the recipient's account
 * is never locked), and the balance is re-read only after that lock is
 * held, so a second transfer queued behind the first sees the first's
 * now-committed debit rather than a stale balance. See
 * `test/wallet-transfer-concurrency.integration.test.ts` for the
 * deterministic proof (a held-open raw `FOR UPDATE`, not a hopeful
 * `Promise.all`) that this is a real, closed race, not just one that
 * usually doesn't lose.
 */
@Injectable()
export class WalletService {
  constructor(
    private readonly idempotency: IdempotencyService,
    @Inject(WALLET_REFERENCE_GENERATOR) private readonly generateReference: WalletReferenceGenerator,
  ) {}

  /**
   * Lazily provisions the caller's own `wallet` account on first read —
   * `WalletSchema.accountId` must name a real row, and creating an empty
   * one (no `ledger_entries`, so `balanceKobo` is trivially 0) moves no
   * money and is safe to do from a read. `GET /api/wallet/transactions`
   * below deliberately does *not* do this — an account that has never
   * moved money and a wallet that doesn't exist yet produce the identical
   * empty page, so there is nothing that read needs an account row for.
   */
  async getWallet(db: Database, user: User): Promise<Wallet> {
    const account = await getOrCreateLedgerAccount(db, 'wallet', user.id)
    const balanceKobo = await computeWalletBalance(db, account.id)
    return WalletSchema.parse({ accountId: account.id, currency: 'NGN', balanceKobo, asOf: toIso(new Date()) })
  }

  async transactions(db: Database, user: User, query: PageQuery): Promise<WalletTransactionListResponse> {
    const cursor = this.decodeCursorOrThrow(query.cursor)

    const account = await findLedgerAccount(db, 'wallet', user.id)
    if (account === undefined) return { items: [], nextCursor: null }

    const scope = and(eq(schema.ledgerEntries.accountId, account.id), inArray(schema.postings.kind, ['transfer', 'topup']))
    const where = cursor === undefined ? scope : and(scope, this.beforeCursor(cursor))

    const rows = await db
      .select({ posting: schema.postings, entry: schema.ledgerEntries })
      .from(schema.ledgerEntries)
      .innerJoin(schema.postings, eq(schema.postings.id, schema.ledgerEntries.postingId))
      .where(where)
      .orderBy(desc(this.entryCreatedAtMs()), desc(schema.ledgerEntries.id))
      .limit(query.limit + 1)

    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const items = page.map((row) => rowToWalletTransaction(row.posting, row.entry.amountKobo))

    const last = page.at(-1)
    const nextCursor = hasMore && last !== undefined ? encodeWalletCursor(last.entry.createdAt, last.entry.id) : null

    return { items, nextCursor }
  }

  async transfer(dto: TransferRequest, currentUser: User, idempotencyKey: string): Promise<TransferResponse> {
    const outcome = await this.idempotency.run(currentUser.id, idempotencyKey, dto, (tx) =>
      this.decideTransfer(tx, dto, currentUser, idempotencyKey),
    )
    return this.unwrap(outcome)
  }

  async topup(dto: TopUpRequest, currentUser: User, idempotencyKey: string): Promise<TransferResponse> {
    const outcome = await this.idempotency.run(currentUser.id, idempotencyKey, dto, (tx) =>
      this.decideTopup(tx, dto, currentUser, idempotencyKey),
    )
    return this.unwrap(outcome)
  }

  /** A stored/computed `{status, body}` below 400 is the real response; 400+ is always `ApiError` and must surface as one. */
  private unwrap<T>(outcome: { status: number; body: T | ApiError }): T {
    if (outcome.status >= 400) throw new ApiErrorException(outcome.body as ApiError)
    return outcome.body as T
  }

  private async decideTransfer(
    tx: DbTransaction,
    dto: TransferRequest,
    currentUser: User,
    idempotencyKey: string,
  ): Promise<DecideResult<TransferResponse>> {
    // Pure reads first, before ever taking the row lock below, so a
    // doomed-to-fail transfer (unknown recipient, a self-transfer) never
    // holds it for even the brief window those checks would otherwise cost.
    const recipient = await this.findUserByPhone(tx, dto.toPhone)
    if (recipient === undefined) {
      return this.errorResult('not_found', 'No wallet is registered to that phone number.')
    }
    if (recipient.id === currentUser.id) {
      return this.errorResult('validation_failed', 'You cannot transfer money to yourself.', {
        fields: { toPhone: ['cannot transfer to yourself'] },
      })
    }

    const senderAccount = await getOrCreateLedgerAccount(tx, 'wallet', currentUser.id)

    // Locks this sender's account row for the rest of the transaction: a
    // second, concurrent transfer *from the same sender* blocks here until
    // this transaction commits or rolls back, then re-reads the
    // now-current balance instead of racing this one on a stale read — the
    // exact mechanism `decideVerify`'s own `FOR UPDATE` on `checkout_sessions`/
    // `links` serialises on, applied to the row whose balance this decision
    // actually depends on.
    await tx.select({ id: schema.ledgerAccounts.id }).from(schema.ledgerAccounts).where(eq(schema.ledgerAccounts.id, senderAccount.id)).for('update')

    const balanceKobo = await computeWalletBalance(tx, senderAccount.id)
    if (balanceKobo < dto.amountKobo) {
      return this.errorResult('insufficient_funds', 'Insufficient wallet balance.', { moneyMoved: false })
    }

    const recipientAccount = await getOrCreateLedgerAccount(tx, 'wallet', recipient.id)

    const metadata: PostingWalletMetadata = {
      senderUserId: currentUser.id,
      senderDisplayName: currentUser.displayName,
      recipientUserId: recipient.id,
      recipientDisplayName: recipient.displayName,
      note: dto.note ?? null,
    }
    const postingRow = await this.insertPosting(tx, 'transfer', currentUser.id, idempotencyKey, metadata)

    await tx.insert(schema.ledgerEntries).values([
      { postingId: postingRow.id, accountId: senderAccount.id, amountKobo: -dto.amountKobo },
      { postingId: postingRow.id, accountId: recipientAccount.id, amountKobo: dto.amountKobo },
    ])

    const newBalanceKobo = await computeWalletBalance(tx, senderAccount.id)
    const body = TransferResponseSchema.parse({
      transaction: rowToWalletTransaction(postingRow, -dto.amountKobo),
      wallet: { accountId: senderAccount.id, currency: 'NGN', balanceKobo: newBalanceKobo, asOf: toIso(postingRow.createdAt) },
    })
    return { status: 201, body }
  }

  private async decideTopup(
    tx: DbTransaction,
    dto: TopUpRequest,
    currentUser: User,
    idempotencyKey: string,
  ): Promise<DecideResult<TransferResponse>> {
    // No balance check, no row lock: topping up never refuses for
    // insufficient funds — the `external_funding` account is the
    // simulated gateway's unlimited source (`ledger-accounts.ts`'s own doc
    // comment: "a funding account always is [signed negative]") — and a
    // pure credit to the caller's own wallet has no race to close, the
    // same reasoning `PaymentsService.decideVerify`'s successful leg never
    // locks the merchant's own `merchant_receivable` account either.
    const userAccount = await getOrCreateLedgerAccount(tx, 'wallet', currentUser.id)
    const externalAccount = await getOrCreateLedgerAccount(tx, 'external_funding', null)

    const metadata: PostingWalletMetadata = {
      senderUserId: null,
      senderDisplayName: null,
      recipientUserId: currentUser.id,
      recipientDisplayName: currentUser.displayName,
      note: null,
    }
    const postingRow = await this.insertPosting(tx, 'topup', currentUser.id, idempotencyKey, metadata)

    await tx.insert(schema.ledgerEntries).values([
      { postingId: postingRow.id, accountId: externalAccount.id, amountKobo: -dto.amountKobo },
      { postingId: postingRow.id, accountId: userAccount.id, amountKobo: dto.amountKobo },
    ])

    const newBalanceKobo = await computeWalletBalance(tx, userAccount.id)
    const body = TransferResponseSchema.parse({
      transaction: rowToWalletTransaction(postingRow, dto.amountKobo),
      wallet: { accountId: userAccount.id, currency: 'NGN', balanceKobo: newBalanceKobo, asOf: toIso(postingRow.createdAt) },
    })
    return { status: 201, body }
  }

  /**
   * Mints a fresh `postings` row for a `transfer`/`topup`, retrying on a
   * `postings_reference_unique` collision exactly like
   * `PaymentsService.insertCheckoutSession` — a nested `tx.transaction`
   * (a real `SAVEPOINT`) so only this attempt rolls back, never the outer
   * transaction (see that method's own doc comment for why a plain
   * `tx.insert` can't recover from the same collision). A
   * `postings_idempotency_scope_key_unique` violation is a different
   * failure — two concurrent calls racing the *same* (scope, key) onto two
   * different bodies — and is never retried: it is thrown directly as
   * `idempotency_mismatch`, exactly `decideVerify`'s own handling of the
   * identical constraint, so `IdempotencyService.run`'s wrapping
   * transaction rolls back this loser's work in full.
   */
  private async insertPosting(
    tx: DbTransaction,
    kind: 'transfer' | 'topup',
    idempotencyScope: string,
    idempotencyKey: string,
    metadata: PostingWalletMetadata,
  ): Promise<typeof schema.postings.$inferSelect> {
    for (let attempt = 0; attempt < MAX_REFERENCE_ATTEMPTS; attempt++) {
      const reference = this.generateReference()
      try {
        const [row] = await tx.transaction(async (savepoint) => {
          return savepoint.insert(schema.postings).values({ kind, reference, idempotencyScope, idempotencyKey, metadata }).returning()
        })
        if (row === undefined) throw new Error('wallet: posting insert returned no row')
        return row
      } catch (error) {
        if (isUniqueViolation(error, POSTINGS_REFERENCE_UNIQUE_CONSTRAINT)) continue
        if (isUniqueViolation(error, POSTINGS_IDEMPOTENCY_SCOPE_KEY_CONSTRAINT)) {
          throw new ApiErrorException({
            code: 'idempotency_mismatch',
            message: 'This Idempotency-Key was already used with a different request.',
            moneyMoved: false,
          })
        }
        throw error
      }
    }
    throw new ApiErrorException({ code: 'conflict', message: 'Could not allocate a unique wallet reference. Try again.' })
  }

  private async findUserByPhone(tx: DbTransaction, phone: string): Promise<{ id: string; displayName: string } | undefined> {
    const [row] = await tx
      .select({ id: schema.users.id, displayName: schema.users.displayName })
      .from(schema.users)
      .where(eq(schema.users.phone, phone))
      .limit(1)
    return row
  }

  private decodeCursorOrThrow(cursor: string | undefined): { createdAt: Date; entryId: string } | undefined {
    if (cursor === undefined) return undefined
    const decoded = decodeWalletCursor(cursor)
    if (decoded === undefined) {
      throw new ApiErrorException({
        code: 'validation_failed',
        message: 'Invalid cursor.',
        fields: { cursor: ['not a valid cursor'] },
      })
    }
    return decoded
  }

  private entryCreatedAtMs(): SQL {
    // Same `date_trunc('milliseconds', ...)` truncation as
    // `links.service.ts`'s `createdAtMs`/`postingCreatedAtMs` — a cursor
    // only ever carries millisecond precision (`Date.toISOString()`), so
    // both the `ORDER BY` and the keyset predicate below compare that same
    // truncated expression, never the raw microsecond-precision column, or
    // a row sharing the cursor row's millisecond with smaller microseconds
    // could fail both `<` and `=` and silently vanish from the next page.
    return sql`date_trunc('milliseconds', ${schema.ledgerEntries.createdAt})`
  }

  private beforeCursor(cursor: { createdAt: Date; entryId: string }): SQL | undefined {
    const createdAtMs = this.entryCreatedAtMs()
    return or(lt(createdAtMs, cursor.createdAt), and(eq(createdAtMs, cursor.createdAt), lt(schema.ledgerEntries.id, cursor.entryId)))
  }

  private errorResult<T>(code: ApiError['code'], message: string, extra: Partial<ApiError> = {}): DecideResult<T> {
    const body: ApiError = { code, message, moneyMoved: false, ...extra }
    return { status: HTTP_STATUS_FOR_ERROR[code], body }
  }
}
