import { Injectable } from '@nestjs/common'
import type { LoginRequest, RegisterRequest, User } from '@kobolink/contracts'
import { eq } from 'drizzle-orm'
import { DbService } from '../db/db.service.js'
import { toIso } from '../db/iso-timestamp.js'
import { isUniqueViolation } from '../db/pg-error.js'
import * as schema from '../db/schema/index.js'
import { hashPassword, verifyDummyPassword, verifyPassword } from './password.js'
import { RateLimiterService } from './rate-limiter.service.js'
import { generateSessionId, generateSessionToken, hashSessionToken } from './session-token.js'

/** 30 days for both `client: 'web'` and `client: 'mobile'` — one constant, so the two never quietly drift apart. */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

export interface SessionInfo {
  id: string
  expiresAt: string
}

export type RegisterOutcome =
  | { kind: 'ok'; user: User; session: SessionInfo; token: string }
  /** A taken email *or* phone — the caller decides the (deliberately generic) message; which one is never disclosed. */
  | { kind: 'conflict' }

export type LoginOutcome =
  | { kind: 'ok'; user: User; session: SessionInfo; token: string }
  /** Unknown email and wrong password are the same outcome on purpose — see `login`. */
  | { kind: 'unauthenticated' }
  | { kind: 'rate_limited'; retryAfterSeconds: number }

export interface ResolvedSession {
  user: User
  session: typeof schema.sessions.$inferSelect
}

function toUser(row: typeof schema.users.$inferSelect): User {
  return {
    id: row.id,
    role: row.role,
    email: row.email,
    phone: row.phone,
    displayName: row.displayName,
    createdAt: toIso(row.createdAt),
  }
}

/**
 * Auth's whole surface — register, login, logout (via `resolveSession` +
 * `revokeSession`), `me` (via `resolveSession`) — lives behind this one
 * service so `AuthController` stays a thin HTTP/cookie adapter (status
 * codes, the `Set-Cookie`/`Retry-After` headers) and every actual decision
 * (conflict, unauthenticated, rate-limited, ok) is a plain return value a
 * unit test could exercise without an HTTP request at all, even though the
 * database dependency means these particular methods are exercised by the
 * integration suite instead (`test/auth-*.integration.test.ts`).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  async register(dto: RegisterRequest, userAgent: string | undefined): Promise<RegisterOutcome> {
    const passwordHash = await hashPassword(dto.password)

    try {
      return await this.db.db.transaction(async (tx) => {
        const [userRow] = await tx
          .insert(schema.users)
          .values({
            role: dto.role,
            email: dto.email,
            phone: dto.phone ?? null,
            passwordHash,
            displayName: dto.displayName,
          })
          .returning()
        if (userRow === undefined) throw new Error('register: user insert returned no row')

        const token = generateSessionToken()
        const [sessionRow] = await tx
          .insert(schema.sessions)
          .values({
            id: generateSessionId(),
            userId: userRow.id,
            tokenHash: hashSessionToken(token),
            expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS),
            userAgent: userAgent ?? null,
          })
          .returning()
        if (sessionRow === undefined) throw new Error('register: session insert returned no row')

        return {
          kind: 'ok',
          user: toUser(userRow),
          session: { id: sessionRow.id, expiresAt: toIso(sessionRow.expiresAt) },
          token,
        }
      })
    } catch (error) {
      if (isUniqueViolation(error, 'users_email_unique') || isUniqueViolation(error, 'users_phone_unique')) {
        return { kind: 'conflict' }
      }
      throw error
    }
  }

  /**
   * Wrong password and unknown user must be indistinguishable to the
   * caller — same `unauthenticated` outcome, and `AuthController` gives
   * both the identical response body. An unknown email still pays the cost
   * of an argon2 verify (`verifyDummyPassword`) so the two branches take
   * roughly the same time; see that function's own doc comment.
   *
   * Rate limiting is checked *before* touching the database or argon2 at
   * all — a tripped limiter must reject a request with the *correct*
   * password just as fast as a wrong one, not merely eventually.
   */
  async login(dto: LoginRequest, ip: string, userAgent: string | undefined): Promise<LoginOutcome> {
    const rateCheck = this.rateLimiter.check(dto.email, ip)
    if (!rateCheck.allowed) {
      return { kind: 'rate_limited', retryAfterSeconds: rateCheck.retryAfterSeconds }
    }

    const [userRow] = await this.db.db.select().from(schema.users).where(eq(schema.users.email, dto.email)).limit(1)

    const passwordOk = userRow !== undefined ? await verifyPassword(userRow.passwordHash, dto.password) : await verifyDummyPassword(dto.password)

    if (userRow === undefined || !passwordOk) {
      this.rateLimiter.recordFailure(dto.email, ip)
      return { kind: 'unauthenticated' }
    }

    this.rateLimiter.resetEmail(dto.email)

    const token = generateSessionToken()
    const [sessionRow] = await this.db.db
      .insert(schema.sessions)
      .values({
        id: generateSessionId(),
        userId: userRow.id,
        tokenHash: hashSessionToken(token),
        expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS),
        userAgent: userAgent ?? null,
      })
      .returning()
    if (sessionRow === undefined) throw new Error('login: session insert returned no row')

    return {
      kind: 'ok',
      user: toUser(userRow),
      session: { id: sessionRow.id, expiresAt: toIso(sessionRow.expiresAt) },
      token,
    }
  }

  /**
   * Looks a presented token up by its sha256 digest (never by comparing
   * secrets directly) and rejects — by returning `undefined`, not
   * throwing; `SessionGuard` is what turns that into the `unauthenticated`
   * HTTP response — a session that is missing, expired
   * (`expires_at <= now()`), or revoked (`revoked_at` set, from logout).
   */
  async resolveSession(token: string): Promise<ResolvedSession | undefined> {
    const tokenHash = hashSessionToken(token)
    const [row] = await this.db.db
      .select({ session: schema.sessions, user: schema.users })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
      .where(eq(schema.sessions.tokenHash, tokenHash))
      .limit(1)

    if (row === undefined) return undefined
    if (row.session.revokedAt !== null) return undefined
    if (row.session.expiresAt.getTime() <= Date.now()) return undefined

    return { user: toUser(row.user), session: row.session }
  }

  /** Sets `revoked_at`; idempotent (a second call finds `revoked_at` already set and just overwrites it with a fresh, still-past-tense timestamp). */
  async revokeSession(sessionId: string): Promise<void> {
    await this.db.db.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.id, sessionId))
  }
}
