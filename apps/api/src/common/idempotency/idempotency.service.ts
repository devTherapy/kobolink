import { Injectable } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { ApiErrorException } from '../errors/api-error.exception.js'
import { DbService } from '../../db/db.service.js'
import type { DbTransaction } from '../../db/db.service.js'
import { isUniqueViolation } from '../../db/pg-error.js'
import * as schema from '../../db/schema/index.js'
import { hashRequestBody } from './hash-request.js'

/** `idempotency_keys`' primary key is the `(scope, key)` pair (`0000_legal_mantis.sql`). */
const IDEMPOTENCY_KEYS_PKEY_CONSTRAINT = 'idempotency_keys_scope_key_pk'

export interface IdempotencyOutcome<T> {
  status: number
  body: T
  /** `true` when this call answered from a stored row rather than running `compute`. */
  replayed: boolean
}

/**
 * The one place every money-moving write (`checkout.initialize`,
 * `checkout.verify`, and B8's `wallet.transfer`/`wallet.topup` later) gets
 * its idempotency from — `packages/contracts/README.md`, "Idempotency":
 * `(scope, key, request hash, response)`, where a replay with the same
 * scope/key/body returns the *stored* response verbatim (including its
 * original HTTP status — an error included, since an `ApiError` is as much
 * "the result of this request" as a 2xx body is; see `hash-request.spec.ts`
 * for why the hash itself is order-independent) and the same key with a
 * different body is `idempotency_mismatch`.
 *
 * `compute` runs the caller's actual writes (in `PaymentsService`'s case:
 * resolving the link, deciding an outcome, writing `postings`/
 * `ledger_entries`/`checkout_sessions`) and returns the `{status, body}` to
 * cache; this service wraps that call in one transaction together with the
 * `idempotency_keys` insert, so a request that decided to move money and a
 * request that recorded having decided it are never two separate commits —
 * either both land or neither does.
 *
 * Race handling: two concurrent requests presenting the same never-seen
 * `(scope, key)` both run `compute` in their own transaction; whichever
 * commits its `idempotency_keys` insert first wins outright, and the loser's
 * insert fails `idempotency_keys_scope_key_pk`, which aborts (rolls back)
 * everything else that loser's transaction just did — so its `compute`
 * side-effects never survive to be visible. The loser then re-reads the
 * now-committed row and returns the winner's answer, indistinguishable to
 * its caller from an ordinary replay.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly db: DbService) {}

  async run<T>(
    scope: string,
    key: string,
    requestBody: unknown,
    compute: (tx: DbTransaction) => Promise<{ status: number; body: T }>,
  ): Promise<IdempotencyOutcome<T>> {
    const requestHash = hashRequestBody(requestBody)

    const existing = await this.lookup(scope, key)
    if (existing !== undefined) {
      return this.replay<T>(existing, requestHash)
    }

    try {
      const result = await this.db.db.transaction(async (tx) => {
        const computed = await compute(tx)
        await tx.insert(schema.idempotencyKeys).values({
          scope,
          key,
          requestHash,
          responseStatus: computed.status,
          responseBody: computed.body,
        })
        return computed
      })
      return { ...result, replayed: false }
    } catch (error) {
      if (isUniqueViolation(error, IDEMPOTENCY_KEYS_PKEY_CONSTRAINT)) {
        const raced = await this.lookup(scope, key)
        if (raced !== undefined) return this.replay<T>(raced, requestHash)
      }
      throw error
    }
  }

  /**
   * For a caller whose own `compute()` lost a race to a *different*,
   * downstream uniqueness constraint before ever reaching this service's own
   * `idempotency_keys` insert — B8's `WalletService.insertPosting` catching
   * `postings_idempotency_scope_key_unique` is the motivating case. That
   * constraint firing means some other request already committed a posting
   * under this exact `(scope, key)`, which — because `postings` and
   * `idempotency_keys` are always written in the same transaction (`run`
   * above) — means that other request's `idempotency_keys` row is committed
   * too: `run`'s own doc comment ("Race handling") already re-reads and
   * replays in the mirror-image case (losing the `idempotency_keys` insert
   * itself); this is that exact same replay, reachable mid-`compute()`
   * instead of only at the top. Returns the winner's stored outcome when
   * `requestBody` hashes to the same value the winner's did (a genuine
   * replay); throws `idempotency_mismatch` via `replay()` when it does not
   * (a genuine same-key-different-body conflict — never silently swallowed);
   * returns `undefined` only if no committed row exists at all yet, which
   * the locking that leads here should make unreachable in practice, but is
   * not this method's place to assume.
   */
  async resolveConcurrentWinner<T>(scope: string, key: string, requestBody: unknown): Promise<IdempotencyOutcome<T> | undefined> {
    const requestHash = hashRequestBody(requestBody)
    const existing = await this.lookup(scope, key)
    if (existing === undefined) return undefined
    return this.replay<T>(existing, requestHash)
  }

  private async lookup(scope: string, key: string): Promise<typeof schema.idempotencyKeys.$inferSelect | undefined> {
    const [row] = await this.db.db
      .select()
      .from(schema.idempotencyKeys)
      .where(and(eq(schema.idempotencyKeys.scope, scope), eq(schema.idempotencyKeys.key, key)))
      .limit(1)
    return row
  }

  private replay<T>(row: typeof schema.idempotencyKeys.$inferSelect, requestHash: string): IdempotencyOutcome<T> {
    if (row.requestHash !== requestHash) {
      throw new ApiErrorException({
        code: 'idempotency_mismatch',
        message: 'This Idempotency-Key was already used with a different request.',
        moneyMoved: false,
      })
    }
    return { status: row.responseStatus, body: row.responseBody as T, replayed: true }
  }
}
