import type { LedgerAccountKind, LinkStatus, PostingKind, UserRole } from '@kobolink/contracts'
import { describe, expectTypeOf, it } from 'vitest'
import type { ledgerAccounts } from './ledger-accounts.js'
import type { links } from './links.js'
import type { postings } from './postings.js'
import type { users } from './users.js'

/**
 * Compile-time only: `expectTypeOf(...).toEqualTypeOf<...>()` is a no-op at
 * runtime (these `it` bodies pass trivially under a normal `vitest run`),
 * and the real check happens wherever these files get type-checked —
 * `npm run typecheck` (`tsc -p tsconfig.json --noEmit`, which includes
 * `src`) — the same way it would for any other type error in this
 * directory. What this guards against: `pgEnum('user_role',
 * UserRoleSchema.options as [string, ...string[]])` compiles too, but
 * widens the inferred column to a bare `string`, so `{ role: 'nope' }`
 * would typecheck as a valid insert. Casting the enum's runtime values to
 * the *contract's* union (`schema/enums.ts`) keeps `$inferSelect`/
 * `$inferInsert` exactly as narrow as `packages/contracts` already
 * promises; this file is what breaks, loudly, in `npm run typecheck` if
 * that cast is ever loosened back to `string`.
 */
describe('enum columns stay the contract union, not a widened string', () => {
  it('users.role is UserRole, not string', () => {
    expectTypeOf<(typeof users.$inferSelect)['role']>().toEqualTypeOf<UserRole>()
  })

  it('ledger_accounts.kind is LedgerAccountKind, not string', () => {
    expectTypeOf<(typeof ledgerAccounts.$inferSelect)['kind']>().toEqualTypeOf<LedgerAccountKind>()
  })

  it('postings.kind is PostingKind, not string', () => {
    expectTypeOf<(typeof postings.$inferSelect)['kind']>().toEqualTypeOf<PostingKind>()
  })

  it('links.status is LinkStatus, not string', () => {
    expectTypeOf<(typeof links.$inferSelect)['status']>().toEqualTypeOf<LinkStatus>()
  })
})
