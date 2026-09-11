import { Inject, Injectable } from '@nestjs/common'
import type {
  CreateLinkRequest,
  LinkListResponse,
  LinkStatus,
  PageQuery,
  PaymentLink,
  PaymentListResponse,
  User,
} from '@kobolink/contracts'
import { and, desc, eq, gt, inArray, lt, or, type SQL, sql } from 'drizzle-orm'
import { ApiErrorException } from '../common/errors/api-error.exception.js'
import { DbService } from '../db/db.service.js'
import { fromIso } from '../db/iso-timestamp.js'
import { isUniqueViolation } from '../db/pg-error.js'
import * as schema from '../db/schema/index.js'
import { decodeLinkCursor, encodeLinkCursor } from './link-cursor.js'
import { LINK_CODE_GENERATOR, type LinkCodeGenerator } from './link-code.generator.js'
import { toPaymentLink } from './link-mapper.js'

/** `links.code` is the primary key (Postgres auto-names it `links_pkey`); a collision is this constraint firing on insert. */
const LINKS_PKEY_CONSTRAINT = 'links_pkey'
/**
 * `newLinkCode` draws from a 54-symbol, 8-character alphabet (~46 bits) — a
 * true collision against an existing row is vanishingly unlikely even at
 * scale. This many attempts exists only to bound the loop and turn a
 * catastrophically unlucky run (or a broken generator) into a clean
 * `conflict` response instead of an infinite retry.
 */
const MAX_CODE_ATTEMPTS = 8

interface LinkStats {
  paymentCount: number
  totalPaidKobo: number
}

const ZERO_STATS: LinkStats = { paymentCount: 0, totalPaidKobo: 0 }

/**
 * `POST/GET /api/links`, `GET/PATCH /api/links/:code`, `GET
 * /api/links/:code/payments` — PLAN.md's B3 row. Every route
 * (`LinksController`) is guarded by `SessionGuard` + `MerchantGuard`, so
 * every method here takes the resolved `User` and scopes its query by
 * `user.id` — "another merchant's link is `not_found`, never `forbidden`"
 * (`packages/contracts/README.md`) is enforced by that scoping, not by a
 * second authorisation check: a row that exists but is not this merchant's
 * and a row that does not exist at all produce the identical `undefined`.
 */
@Injectable()
export class LinksService {
  constructor(
    private readonly db: DbService,
    @Inject(LINK_CODE_GENERATOR) private readonly generateCode: LinkCodeGenerator,
  ) {}

  /**
   * The client never supplies a code (`CreateLinkRequestSchema` has no such
   * field) — the server generates one and retries on a `links_pkey` unique
   * violation, per DESIGN-SPEC.md §3: "Collisions are handled by the insert
   * failing and the caller retrying, not by hoping."
   */
  async create(user: User, dto: CreateLinkRequest): Promise<PaymentLink> {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const code = this.generateCode()
      try {
        const [row] = await this.db.db
          .insert(schema.links)
          .values({
            code,
            merchantUserId: user.id,
            title: dto.title,
            description: dto.description ?? null,
            amountKobo: dto.amountKobo,
            isReusable: dto.isReusable,
            expiresAt: dto.expiresAt === null ? null : fromIso(dto.expiresAt),
          })
          .returning()
        if (row === undefined) throw new Error('links: create insert returned no row')
        return toPaymentLink(row, user.displayName, 0, 0)
      } catch (error) {
        if (isUniqueViolation(error, LINKS_PKEY_CONSTRAINT)) continue
        throw error
      }
    }
    throw new ApiErrorException({
      code: 'conflict',
      message: 'Could not allocate a unique link code. Try again.',
    })
  }

  /** Merchant-scoped, newest first by `createdAt` (ties broken by `code`), opaque cursor pagination. */
  async list(user: User, query: PageQuery): Promise<LinkListResponse> {
    const cursor = this.decodeCursorOrThrow(query.cursor)

    const scope = eq(schema.links.merchantUserId, user.id)
    const where = cursor === undefined ? scope : and(scope, this.beforeCursor(cursor))

    const rows = await this.db.db
      .select()
      .from(schema.links)
      .where(where)
      .orderBy(desc(this.createdAtMs()), desc(schema.links.code))
      .limit(query.limit + 1)

    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows

    const stats = await this.computeLinkStatsBatch(
      page.map((row) => row.code),
      user.id,
    )
    const items = page.map((row) => toPaymentLink(row, user.displayName, ...this.statsTuple(stats, row.code)))

    const last = page.at(-1)
    const nextCursor = hasMore && last !== undefined ? encodeLinkCursor(last.createdAt, last.code) : null

    return { items, nextCursor }
  }

  /** `undefined` for "no such code" and "exists but belongs to a different merchant" alike — see the class doc comment. */
  async getByCode(user: User, code: string): Promise<PaymentLink | undefined> {
    const row = await this.findOwnedRow(user.id, code)
    if (row === undefined) return undefined
    const stats = await this.computeLinkStats(code, user.id)
    return toPaymentLink(row, user.displayName, stats.paymentCount, stats.totalPaidKobo)
  }

  async updateStatus(user: User, code: string, status: LinkStatus): Promise<PaymentLink | undefined> {
    const [row] = await this.db.db
      .update(schema.links)
      .set({ status })
      .where(and(eq(schema.links.code, code), eq(schema.links.merchantUserId, user.id)))
      .returning()
    if (row === undefined) return undefined
    const stats = await this.computeLinkStats(code, user.id)
    return toPaymentLink(row, user.displayName, stats.paymentCount, stats.totalPaidKobo)
  }

  /**
   * `undefined` when the link is not this merchant's (or doesn't exist) —
   * the controller turns that into the same `not_found` every other route
   * gives a wrong-merchant code.
   *
   * B5 (`checkout.initialize`/`checkout.verify`) has not landed: nothing
   * ever writes a `postings` row of kind `link_payment`, so this always
   * answers an empty, correctly shaped page today. Once B5 lands, this is
   * where its payments projection (or a query over `postings`/
   * `ledger_entries` shaped like `computeLinkStats` below) gets wired in —
   * see this feature's PR description for the exact assumption B5 needs to
   * either keep or correct.
   *
   * `query.cursor` is still decoded — and thrown on if it doesn't parse —
   * even though nothing here reads the result yet: the underlying data
   * source isn't wired in until B5, but a garbage cursor should already
   * behave the same way it does on `list()` (400 `validation_failed`)
   * rather than silently paging past it into an empty result.
   */
  async payments(user: User, code: string, query: PageQuery): Promise<PaymentListResponse | undefined> {
    this.decodeCursorOrThrow(query.cursor)
    const row = await this.findOwnedRow(user.id, code)
    if (row === undefined) return undefined
    return { items: [], nextCursor: null }
  }

  private async findOwnedRow(merchantId: string, code: string): Promise<typeof schema.links.$inferSelect | undefined> {
    const [row] = await this.db.db.select().from(schema.links).where(eq(schema.links.code, code)).limit(1)
    if (row?.merchantUserId !== merchantId) return undefined
    return row
  }

  private decodeCursorOrThrow(cursor: string | undefined): { createdAt: Date; code: string } | undefined {
    if (cursor === undefined) return undefined
    const decoded = decodeLinkCursor(cursor)
    if (decoded === undefined) {
      throw new ApiErrorException({
        code: 'validation_failed',
        message: 'Invalid cursor.',
        fields: { cursor: ['not a valid cursor'] },
      })
    }
    return decoded
  }

  /**
   * `date_trunc('milliseconds', created_at)` — never the bare column — so
   * this lines up with what a cursor actually encodes (a JS `Date`, which
   * cannot hold more than millisecond precision; see `link-cursor.ts`'s doc
   * comment). Shared by `list`'s `ORDER BY` and `beforeCursor`'s predicate:
   * comparing a millisecond-truncated cursor against the full
   * microsecond-precision column let a row sharing the cursor row's
   * millisecond, but with smaller microseconds, fail both `<` and `=` and
   * silently drop out of the walk — using the same truncated expression on
   * both sides (and to order by) closes that gap.
   */
  private createdAtMs(): SQL {
    return sql`date_trunc('milliseconds', ${schema.links.createdAt})`
  }

  /** Keyset predicate for "strictly after `cursor` in the `createdAtMs() desc, code desc` order". */
  private beforeCursor(cursor: { createdAt: Date; code: string }): SQL | undefined {
    const createdAtMs = this.createdAtMs()
    return or(
      lt(createdAtMs, cursor.createdAt),
      and(eq(createdAtMs, cursor.createdAt), lt(schema.links.code, cursor.code)),
    )
  }

  private statsTuple(stats: Map<string, LinkStats>, code: string): [number, number] {
    const found = stats.get(code) ?? ZERO_STATS
    return [found.paymentCount, found.totalPaidKobo]
  }

  /**
   * Derives `paymentCount`/`totalPaidKobo` from successful `link_payment`
   * postings — never a separately-written counter a client (or a bug) could
   * drift from the ledger. A posting only exists for a payment that actually
   * completed (round 2 of B1's own review: "B5 must ... only ever write a
   * `postings` row for a transaction that actually completed"), so counting
   * postings *is* counting successes; no `status` filter is needed or
   * possible here.
   *
   * Attribution assumption, since B1's schema has no dedicated link-postings
   * join table: a `link_payment` posting's `metadata` carries `linkCode`
   * (`postings.metadata ->> 'linkCode' = code`), and the credit side of that
   * posting — the positive entry against the merchant's own
   * `merchant_receivable` account — is the amount that counts. `postings`'
   * own `jsonb` `metadata` column (see that file's doc comment) is otherwise
   * unshaped, so this is this feature's own convention, not yet
   * cross-checked against B5's real write path; flagged in the PR
   * description as the one thing B5 may need to conform to (or correct this
   * query to match) once it lands.
   */
  private async computeLinkStats(code: string, merchantId: string): Promise<LinkStats> {
    const batch = await this.computeLinkStatsBatch([code], merchantId)
    return batch.get(code) ?? ZERO_STATS
  }

  private async computeLinkStatsBatch(codes: string[], merchantId: string): Promise<Map<string, LinkStats>> {
    const result = new Map<string, LinkStats>()
    if (codes.length === 0) return result

    const linkCodeExpr = sql<string>`${schema.postings.metadata} ->> 'linkCode'`

    const rows = await this.db.db
      .select({ linkCode: linkCodeExpr, amountKobo: schema.ledgerEntries.amountKobo })
      .from(schema.postings)
      .innerJoin(schema.ledgerEntries, eq(schema.ledgerEntries.postingId, schema.postings.id))
      .innerJoin(schema.ledgerAccounts, eq(schema.ledgerAccounts.id, schema.ledgerEntries.accountId))
      .where(
        and(
          eq(schema.postings.kind, 'link_payment'),
          eq(schema.ledgerAccounts.kind, 'merchant_receivable'),
          eq(schema.ledgerAccounts.ownerUserId, merchantId),
          gt(schema.ledgerEntries.amountKobo, 0),
          inArray(linkCodeExpr, codes),
        ),
      )

    for (const row of rows) {
      if (row.linkCode === null) continue
      const existing = result.get(row.linkCode) ?? { paymentCount: 0, totalPaidKobo: 0 }
      result.set(row.linkCode, {
        paymentCount: existing.paymentCount + 1,
        totalPaidKobo: existing.totalPaidKobo + row.amountKobo,
      })
    }

    // See ledger-entries.ts's own doc comment: `mode: 'number'` is safe for
    // one bounded row but never for an aggregate — verify before trusting a
    // summed totalPaidKobo the same way a single row's value is trusted.
    for (const [code, stats] of result) {
      if (!Number.isSafeInteger(stats.totalPaidKobo)) {
        throw new Error(`links: totalPaidKobo for ${code} exceeded Number.MAX_SAFE_INTEGER`)
      }
    }

    return result
  }
}
