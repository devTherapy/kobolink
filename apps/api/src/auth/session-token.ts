import { createHash, randomBytes } from 'node:crypto'
import { nanoid } from 'nanoid'

/**
 * Two different random values back every session, deliberately never the
 * same one (see `sessions.ts`'s own doc comment for the reasoning
 * `db/schema` already committed to):
 *
 * - `session.id` (`generateSessionId`) is an opaque *reference* — sent to
 *   the client in `AuthResponse.session.id`, fine to log, fine to show in a
 *   future "your devices" screen. It is not a secret and never proves
 *   anything on its own.
 * - the session *token* (`generateSessionToken`) is the actual credential —
 *   the web cookie's value or the mobile bearer token. Only its sha256
 *   digest (`hashSessionToken`) is ever written to `sessions.token_hash`;
 *   the raw value exists only in the response that mints it and in
 *   whatever the client stores it in.
 *
 * `packages/contracts`' `IdSchema` bounds `session.id` to
 * `^[A-Za-z0-9_-]+$`, 1-64 chars — nanoid's default alphabet already is
 * exactly that character set (see `db/schema/id.ts`), so `generateSessionId`
 * reuses it directly rather than inventing a second encoding. 22 characters
 * (not nanoid's own 21-character default) is deliberate: log2(64) * 22 ≈
 * 132 bits, comfortably over the ≥128-bit floor this PR's own design set for
 * the opaque id (review round 1, finding 9: an earlier version of this
 * comment cited DESIGN-SPEC.md/PLAN.md for that specific floor, which
 * neither document states — the floor is this feature's own call) — 21
 * characters (≈126 bits) would round down under it.
 *
 * The session token is not an `Id` — it never appears in a URL path or a
 * `packages/contracts` schema field named `id` — so it is free to use
 * `base64url` over raw bytes instead of nanoid's alphabet-sampling
 * approach. 32 bytes is exactly 256 bits, matching the same PR's ≥256-bit
 * floor for the secret half of the pair.
 */
const SESSION_ID_LENGTH = 22
const SESSION_TOKEN_BYTES = 32

export function generateSessionId(): string {
  return nanoid(SESSION_ID_LENGTH)
}

export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
}

/**
 * The only thing ever compared against `sessions.token_hash` — a session is
 * looked up by hashing the presented token and matching digests, never by
 * comparing secrets directly (the same discipline `password_hash` already
 * uses). sha256 hex output is exactly 64 characters, matching
 * `sessions.token_hash`'s `varchar(64)` column.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
