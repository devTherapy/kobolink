import { index, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { newId } from './id.js'
import { users } from './users.js'

/**
 * One shape for both client kinds (`ClientKindSchema`: `web` | `mobile`).
 *
 * `id` is *not* a secret — `AuthResponseSchema.session.id` sends it to the
 * client directly, as an opaque reference (so a future "manage devices"
 * endpoint has something to name a session by). What a client authenticates
 * with is a separate random value it holds itself: the web session cookie's
 * value, or the mobile bearer token (`AuthResponse.token`). Only
 * `tokenHash` — a SHA-256 digest of *that* secret — is stored, the same
 * discipline as `passwordHash`. A stolen database (or an accidental log
 * line, a support engineer's query, a backup left somewhere it shouldn't
 * be) then yields no session anyone can replay — knowing every `id` in this
 * table included, since `id` alone was never enough to authenticate; the
 * service looks a request up by hashing the presented secret and comparing
 * digests, never by comparing secrets directly.
 *
 * This was the one column PLAN.md's row left to this feature's judgment
 * ("plus a `token_hash` or equivalent if you decide bearer tokens are
 * stored hashed — say why"); hashing *both* client kinds the same way,
 * rather than only mobile, means auth (B2) has one lookup path instead of
 * two, and a leaked cookie is exactly as contained as a leaked bearer
 * token.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: varchar('id', { length: 64 }).primaryKey().$defaultFn(newId),
    userId: varchar('user_id', { length: 64 })
      .notNull()
      .references(() => users.id),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    // mode: 'date' — see src/db/iso-timestamp.ts.
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** Set on logout (or forced revocation). Non-null means dead regardless of `expiresAt`. */
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('sessions_user_idx').on(table.userId),
    uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
  ],
)
