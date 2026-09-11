import {
  type LedgerAccountKind,
  LedgerAccountKindSchema,
  type LinkStatus,
  LinkStatusSchema,
  type PostingKind,
  PostingKindSchema,
  type UserRole,
  UserRoleSchema,
} from '@kobolink/contracts'
import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * Every enum column's value set is read from the corresponding
 * `packages/contracts` zod schema instead of being retyped here. That is
 * the round-trip guarantee made mechanical: if a domain agent ever adds a
 * role or a status to the contract without a matching migration, this file
 * still compiles (the enum just gains the new member), and `drizzle-kit
 * generate` immediately reports the drift as a schema diff instead of a bug
 * discovered in production.
 *
 * `pgEnum` needs a non-empty tuple type (`[string, ...string[]]`) and is
 * generic over it — `PgEnum<T>`'s column then infers `data: T[number]`. A
 * zod enum's `.options` is typed as the wider `string[]` at this call site
 * even though it is non-empty at runtime by construction, so casting to
 * `string[]` (as the previous version of this file did) is not just a
 * type-level formality: it throws away the literal union and makes every
 * inferred column — `users.$inferSelect.role`, for instance — a bare
 * `string`, which happily accepts a role that was never in the enum. The
 * cast below targets the *contract's own* union type instead, so the
 * `pgEnum` call stays exactly as informal (still "trust the runtime
 * values", not a new assumption) while the column it produces is typed as
 * narrowly as the contract already promises.
 */
export const userRoleEnum = pgEnum('user_role', UserRoleSchema.options as [UserRole, ...UserRole[]])
export const ledgerAccountKindEnum = pgEnum(
  'ledger_account_kind',
  LedgerAccountKindSchema.options as [LedgerAccountKind, ...LedgerAccountKind[]],
)
export const postingKindEnum = pgEnum('posting_kind', PostingKindSchema.options as [PostingKind, ...PostingKind[]])
export const linkStatusEnum = pgEnum('link_status', LinkStatusSchema.options as [LinkStatus, ...LinkStatus[]])
