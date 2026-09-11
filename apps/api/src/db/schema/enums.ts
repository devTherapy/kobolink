import { LedgerAccountKindSchema, LinkStatusSchema, PostingKindSchema, UserRoleSchema } from '@kobolink/contracts'
import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * Every enum column's value set is read from the corresponding
 * `packages/contracts` zod schema instead of being retyped here. That is
 * the round-trip guarantee made mechanical: if a domain agent ever adds a
 * role or a status to the contract without a matching migration, this file
 * still compiles (the enum just gains the new member), and `drizzle-kit
 * generate` immediately reports the drift as a schema diff instead of a bug
 * discovered in production.
 */
// `pgEnum` needs a non-empty tuple type (`[string, ...string[]]`); a zod
// enum's `.options` is typed as the wider `string[]` here even though it is
// non-empty at runtime by construction, so the cast below is a type-level
// formality, not a real assumption.
export const userRoleEnum = pgEnum('user_role', UserRoleSchema.options as [string, ...string[]])
export const ledgerAccountKindEnum = pgEnum(
  'ledger_account_kind',
  LedgerAccountKindSchema.options as [string, ...string[]],
)
export const postingKindEnum = pgEnum('posting_kind', PostingKindSchema.options as [string, ...string[]])
export const linkStatusEnum = pgEnum('link_status', LinkStatusSchema.options as [string, ...string[]])
