import { Inject, Injectable } from '@nestjs/common'
import type {
  CreateLinkRequest,
  LinkListResponse,
  LinkStatus,
  PageQuery,
  PaymentLink,
  PaymentListResponse,
  PublicLinkResponse,
  User,
} from '@kobolink/contracts'
import { resolveLink, toPublicLink, toPublicLinkState } from '@kobolink/contracts'
import { and, desc, eq, lt, or, type SQL, sql } from 'drizzle-orm'
import { ApiErrorException } from '../common/errors/api-error.exception.js'
import { DbService } from '../db/db.service.js'
import type { Executor } from '../db/db.service.js'
import { fromIso } from '../db/iso-timestamp.js'
import { isUniqueViolation } from '../db/pg-error.js'
import * as schema from '../db/schema/index.js'
import { decodeLinkCursor, encodeLinkCursor } from './link-cursor.js'
import { LINK_CODE_GENERATOR, type LinkCodeGenerator } from './link-code.generator.js'
import { toPaymentLink } from './link-mapper.js'
import { computeLinkStats, computeLinkStatsBatch, type LinkStats, ZERO_LINK_STATS } from './link-stats.js'
import { decodePaymentCursor, encodePaymentCursor } from '../payments/payment-cursor.js'
import { rowToPayment } from '../payments/payment-mapper.js'

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

/**
 * `POST/GET /api/links`, `GET/PATCH /api/links/:code`, `GET
 * /api/links/:code/payments` — PLAN.md's B3 row. Every route
 * (`LinksController`) is guarded by `SessionGuard` + `MerchantGuard`, so
 * every method here takes the resolved `User` and scopes its query by
 * `user.id` — "another merchant's link is `not_found`, never `forbidden`"
 * (`packages/contracts/README.md`) is enforced by that scoping, not by a
 * second authorisation check: a row that exists but is not this merchant's
 * and a row that does not exist at all produce the identical `undefined`.
 *
 * `getForCheckout` is exported to B5's `PaymentsService` too (via
 * `LinksModule`'s exports) — see that method's own doc comment for why it,
 * uniquely, takes an `Executor` instead of always using `this.db.db`.
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

    const stats = await computeLinkStatsBatch(
      this.db.db,
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
    const stats = await computeLinkStats(this.db.db, code, user.id)
    return toPaymentLink(row, user.displayName, stats.paymentCount, stats.totalPaidKobo)
  }

  /**
   * `GET /api/links/:code/public` (`PublicLinksController`) — PLAN.md's B4
   * row, built over the same `getForCheckout` B5 uses.
   */
  async resolvePublic(code: string): Promise<PublicLinkResponse | undefined> {
    const resolved = await this.getForCheckout(this.db.db, code)
    if (resolved === undefined) return undefined

    const resolution = resolveLink(resolved.link)
    const state = toPublicLinkState(resolution)
    if (state === null) {
      throw new Error(`links: resolveLink for an existing row (${code}) produced 'not-found'`)
    }
    return { state, link: toPublicLink(resolved.link) }
  }

  /**
   * The merchant-scoped, full-fidelity read `PublicLinksController` cannot
   * expose (it carries `merchantUserId`, needed to attribute a
   * `link_payment` posting's `merchant_receivable` account) — shared by
   * `resolvePublic` above and by B5's `PaymentsService`, which calls this
   * *inside its own posting transaction* (`executor` is that transaction,
   * there) so the payability check a `checkout.verify` bases its decision on
   * reads the same in-flight state its own writes are about to change,
   * never a separate, possibly-stale connection. Every other caller in this
   * class passes `this.db.db` and gets the plain pooled read `resolvePublic`
   * always used.
   */
  async getForCheckout(executor: Executor, code: string): Promise<{ link: PaymentLink; merchantUserId: string } | undefined> {
    const [row] = await executor
      .select({ link: schema.links, merchantName: schema.users.displayName })
      .from(schema.links)
      .innerJoin(schema.users, eq(schema.users.id, schema.links.merchantUserId))
      .where(eq(schema.links.code, code))
      .limit(1)
    if (row === undefined) return undefined

    const stats = await computeLinkStats(executor, code, row.link.merchantUserId)
    const paymentLink = toPaymentLink(row.link, row.merchantName, stats.paymentCount, stats.totalPaidKobo)
    return { link: paymentLink, merchantUserId: row.link.merchantUserId }
  }

  async updateStatus(user: User, code: string, status: LinkStatus): Promise<PaymentLink | undefined> {
    const [row] = await this.db.db
      .update(schema.links)
      .set({ status })
      .where(and(eq(schema.links.code, code), eq(schema.links.merchantUserId, user.id)))
      .returning()
    if (row === undefined) return undefined
    const stats = await computeLinkStats(this.db.db, code, user.id)
    return toPaymentLink(row, user.displayName, stats.paymentCount, stats.totalPaidKobo)
  }

  /**
   * `GET /api/links/:code/payments` — newest first, including failed
   * payments (`packages/contracts/README.md`: "Includes failed payments...
   * so the merchant sees declines"). B5 landed: every `link_payment`
   * posting tagged with this `code` (`postings.metadata ->> 'linkCode'`,
   * the same convention `computeLinkStats` reads) is one page row, success
   * or failure alike — `rowToPayment` (`payments/payment-mapper.ts`)
   * projects the posting (never `ledger_entries` directly; a failure has
   * none) into the contract's `Payment` shape.
   */
  async payments(user: User, code: string, query: PageQuery): Promise<PaymentListResponse | undefined> {
    const cursor = this.decodePaymentCursorOrThrow(query.cursor)
    const row = await this.findOwnedRow(user.id, code)
    if (row === undefined) return undefined

    const linkCodeExpr = sql<string>`${schema.postings.metadata} ->> 'linkCode'`
    const scope = and(eq(schema.postings.kind, 'link_payment'), eq(linkCodeExpr, code))
    const where = cursor === undefined ? scope : and(scope, this.beforePaymentCursor(cursor))

    const rows = await this.db.db
      .select()
      .from(schema.postings)
      .where(where)
      .orderBy(desc(this.postingCreatedAtMs()), desc(schema.postings.reference))
      .limit(query.limit + 1)

    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const items = page.map((r) => rowToPayment(r))

    const last = page.at(-1)
    const nextCursor = hasMore && last !== undefined ? encodePaymentCursor(last.createdAt, last.reference) : null

    return { items, nextCursor }
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

  private decodePaymentCursorOrThrow(cursor: string | undefined): { createdAt: Date; reference: string } | undefined {
    if (cursor === undefined) return undefined
    const decoded = decodePaymentCursor(cursor)
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

  /** Same reasoning as `createdAtMs`, for `payments`'s keyset over `postings.created_at`. */
  private postingCreatedAtMs(): SQL {
    return sql`date_trunc('milliseconds', ${schema.postings.createdAt})`
  }

  /** Keyset predicate for "strictly after `cursor` in the `createdAtMs() desc, code desc` order". */
  private beforeCursor(cursor: { createdAt: Date; code: string }): SQL | undefined {
    const createdAtMs = this.createdAtMs()
    return or(
      lt(createdAtMs, cursor.createdAt),
      and(eq(createdAtMs, cursor.createdAt), lt(schema.links.code, cursor.code)),
    )
  }

  /** Keyset predicate for `payments`'s `postingCreatedAtMs() desc, reference desc` order. */
  private beforePaymentCursor(cursor: { createdAt: Date; reference: string }): SQL | undefined {
    const createdAtMs = this.postingCreatedAtMs()
    return or(
      lt(createdAtMs, cursor.createdAt),
      and(eq(createdAtMs, cursor.createdAt), lt(schema.postings.reference, cursor.reference)),
    )
  }

  private statsTuple(stats: Map<string, LinkStats>, code: string): [number, number] {
    const found = stats.get(code) ?? ZERO_LINK_STATS
    return [found.paymentCount, found.totalPaidKobo]
  }
}
