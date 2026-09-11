import { Injectable } from '@nestjs/common'
import { checkWindow, pruneWindow } from './rate-limit-window.js'

/**
 * Login abuse control — DESIGN-SPEC.md §5 ("Login abuse: rate limit per
 * phone/email and per IP"), PLAN.md's B2 row. Two independent buckets,
 * keyed by the normalised login email and by the caller's IP
 * (`client-ip.ts`); a request is rejected when *either* bucket is at its
 * limit within the trailing 15-minute window. A successful login resets
 * only the email bucket (`resetEmail`) — the IP bucket is deliberately
 * left alone, since a single IP hammering many different email addresses
 * (credential stuffing) is exactly the pattern the IP bucket exists to
 * catch, and one of those guesses eventually landing on a real password
 * for one account should not clear it.
 *
 * **In-memory, not Postgres.** This process is a single Node instance with
 * no horizontal scaling in front of it yet (nothing in this repo runs more
 * than one `apps/api` process), so a `Map` needs no cross-process
 * coordination to be correct right now, costs no migration, and — same as
 * every other "pick one, justify it" call in this feature — the window
 * arithmetic it wraps (`rate-limit-window.ts`) is pure and unit-tested with
 * no database at all, where a Postgres-table version would need a real
 * container for the same coverage. The real cost, named up front rather
 * than glossed over: every counter resets on a process restart or deploy,
 * and a second `apps/api` instance would keep its own, disjoint counters —
 * neither is acceptable once this ships behind a load balancer or an
 * autoscaler, at which point the counters belong in Postgres (or Redis)
 * instead. Tracked in this PR's "what is deliberately not done yet".
 */
@Injectable()
export class RateLimiterService {
  private static readonly WINDOW_MS = 15 * 60 * 1000
  private static readonly EMAIL_LIMIT = 5
  private static readonly IP_LIMIT = 20
  /** Defensive cap on stored timestamps per key, so a key that is failed against forever (and never reset) cannot grow unbounded between prunes. */
  private static readonly MAX_STORED = 100

  private readonly emailFailures = new Map<string, number[]>()
  private readonly ipFailures = new Map<string, number[]>()

  check(email: string, ip: string, now: number = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const emailCheck = checkWindow(
      this.emailFailures.get(email) ?? [],
      now,
      RateLimiterService.WINDOW_MS,
      RateLimiterService.EMAIL_LIMIT,
    )
    const ipCheck = checkWindow(
      this.ipFailures.get(ip) ?? [],
      now,
      RateLimiterService.WINDOW_MS,
      RateLimiterService.IP_LIMIT,
    )
    return {
      allowed: emailCheck.allowed && ipCheck.allowed,
      retryAfterSeconds: Math.max(emailCheck.retryAfterSeconds, ipCheck.retryAfterSeconds),
    }
  }

  /** Call once per failed login attempt (wrong password or unknown user) — never for a request already rejected by `check`. */
  recordFailure(email: string, ip: string, now: number = Date.now()): void {
    this.push(this.emailFailures, email, now)
    this.push(this.ipFailures, ip, now)
  }

  /** Call once a login with this email succeeds. */
  resetEmail(email: string): void {
    this.emailFailures.delete(email)
  }

  private push(bucket: Map<string, number[]>, key: string, now: number): void {
    const pruned = pruneWindow(bucket.get(key) ?? [], now, RateLimiterService.WINDOW_MS)
    pruned.push(now)
    const trimmed = pruned.length > RateLimiterService.MAX_STORED ? pruned.slice(-RateLimiterService.MAX_STORED) : pruned
    bucket.set(key, trimmed)
  }
}
