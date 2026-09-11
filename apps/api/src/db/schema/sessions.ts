import { index, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { newId } from './id.js'
import { users } from './users.js'

/**
 * One shape for both client kinds (`ClientKindSchema`: `web` | `mobile`).
 *
 * `id` is an internal, opaque row id — it is never sent to a client and
 * never accepted back from one. What a client actually holds is a random
 * secret: the web session cookie value, or the mobile bearer token. Only
 * `tokenHash` — a SHA-256 digest of that secret — is stored, the same
 * discipline as `passwordHash`. A stolen database (or an accidental log
 * line, a support engineer's query, a backup left somewhere it shouldn't
 * be) then yields no session anyone can replay; the service looks a
 * request up by hashing the presented secret and comparing digests, never
 * by comparing secrets directly.
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
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    /** Set on logout (or forced revocation). Non-null means dead regardless of `expiresAt`. */
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('sessions_user_idx').on(table.userId),
    uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
  ],
)
