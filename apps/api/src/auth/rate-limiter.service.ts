import { Injectable, Optional, type OnModuleDestroy } from '@nestjs/common'
import { checkWindow, pruneWindow } from './rate-limit-window.js'

export interface RateLimitResult {
  allowed: boolean
  retryAfterSeconds: number
}

export interface RateLimiterServiceOptions {
  /** Hard cap on distinct keys per bucket. Defaults to `DEFAULT_MAX_KEYS`. */
  maxKeysPerBucket?: number
  /** How often the self-owned sweep runs. Defaults to `DEFAULT_SWEEP_INTERVAL_MS`. Tests pass a short value instead of waiting minutes. */
  sweepIntervalMs?: number
}

/**
 * Login/registration abuse control — DESIGN-SPEC.md §5, PLAN.md's B2 row.
 * Two independent buckets, keyed by the normalised login email and by the
 * caller's IP (`client-ip.ts`); `tryAcquireLogin` is rejected when *either*
 * bucket is already at its limit within the trailing 15-minute window.
 * `tryAcquireIp` (registration — review round 1, finding 3: registration
 * was unthrottled) reuses the exact same IP bucket `tryAcquireLogin` does,
 * rather than a second one: both are unauthenticated writes one address can
 * hammer, and one shared counter is simpler than justifying two limits
 * independently.
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
 *
 * **Review round 1, finding 2 — unbounded key growth.** Nothing previously
 * evicted a key once its window aged out, so a flood of distinct emails/IPs
 * (each hit once, well under any per-key limit) grew both maps forever.
 * Two independent defences now bound that: a self-owned interval
 * (`sweep`, cleared in `onModuleDestroy`) that drops any key whose window
 * has fully aged out, and a hard per-bucket key cap (`maxKeysPerBucket`)
 * that evicts the least-recently-touched key the moment a bucket would
 * exceed it — the cap protects against a burst large enough to arrive
 * *within* one sweep interval, which the sweep alone would not catch in
 * time.
 */
@Injectable()
export class RateLimiterService implements OnModuleDestroy {
  private static readonly WINDOW_MS = 15 * 60 * 1000
  private static readonly EMAIL_LIMIT = 5
  private static readonly IP_LIMIT = 20
  /** Defensive cap on stored timestamps per key, so a key that is failed against forever (and never reset) cannot grow unbounded between sweeps. */
  private static readonly MAX_STORED = 100
  private static readonly DEFAULT_MAX_KEYS = 10_000
  private static readonly DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000

  private readonly emailFailures = new Map<string, number[]>()
  private readonly ipFailures = new Map<string, number[]>()
  private readonly maxKeysPerBucket: number
  private readonly sweepInterval: NodeJS.Timeout

  constructor(@Optional() options: RateLimiterServiceOptions = {}) {
    this.maxKeysPerBucket = options.maxKeysPerBucket ?? RateLimiterService.DEFAULT_MAX_KEYS
    this.sweepInterval = setInterval(
      () => this.sweep(),
      options.sweepIntervalMs ?? RateLimiterService.DEFAULT_SWEEP_INTERVAL_MS,
    )
    // Never keeps the process alive on its own — a plain script or a test
    // that never calls onModuleDestroy still exits cleanly.
    this.sweepInterval.unref()
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepInterval)
  }

  /**
   * Atomic check-and-reserve for one login attempt — call exactly once,
   * synchronously, *before* any `await` in the caller (the DB lookup, the
   * argon2 verify). Node runs a synchronous call like this to completion
   * before any other request's handler gets a turn, so a burst of
   * genuinely concurrent requests still only ever admits `EMAIL_LIMIT`/
   * `IP_LIMIT` of them.
   *
   * Review round 1, finding 1: the previous shape — a read-only `check()`
   * followed by a `recordFailure()` called only *after* the DB/argon2 work
   * resolved — left a window between the check and that async work where
   * every request already in flight saw the same pre-request bucket state
   * and was admitted, regardless of how many others were admitted
   * alongside it. Reserving synchronously at admission time (this method)
   * closes that window entirely; nothing about the fix depends on timing.
   *
   * Reserves *both* buckets, but only when both already allow the
   * attempt — a request blocked by one bucket is not counted against the
   * other either, since it never actually reaches the database or argon2
   * at all.
   */
  tryAcquireLogin(email: string, ip: string, now: number = Date.now()): RateLimitResult {
    const emailCheck = checkWindow(
      this.emailFailures.get(email) ?? [],
      now,
      RateLimiterService.WINDOW_MS,
      RateLimiterService.EMAIL_LIMIT,
    )
    const ipCheck = checkWindow(this.ipFailures.get(ip) ?? [], now, RateLimiterService.WINDOW_MS, RateLimiterService.IP_LIMIT)
    const allowed = emailCheck.allowed && ipCheck.allowed
    if (allowed) {
      this.reserve(this.emailFailures, email, now)
      this.reserve(this.ipFailures, ip, now)
    }
    return { allowed, retryAfterSeconds: Math.max(emailCheck.retryAfterSeconds, ipCheck.retryAfterSeconds) }
  }

  /**
   * The IP-only half of `tryAcquireLogin`'s reservation, applied to
   * registration (review round 1, finding 3). Same atomicity reasoning:
   * call synchronously before any `await`.
   */
  tryAcquireIp(ip: string, now: number = Date.now()): RateLimitResult {
    const ipCheck = checkWindow(this.ipFailures.get(ip) ?? [], now, RateLimiterService.WINDOW_MS, RateLimiterService.IP_LIMIT)
    if (ipCheck.allowed) this.reserve(this.ipFailures, ip, now)
    return { allowed: ipCheck.allowed, retryAfterSeconds: ipCheck.retryAfterSeconds }
  }

  /**
   * Call once a login with this email succeeds. Clears this successful
   * attempt's own reservation along with every prior failure — the IP
   * bucket's reservation from this same attempt is deliberately left in
   * place (a single IP hammering many different emails should not get a
   * free pass just because one guess eventually landed).
   */
  resetEmail(email: string): void {
    this.emailFailures.delete(email)
  }

  /**
   * Deletes any key whose entire timestamp window has aged out. Runs on
   * `sweepIntervalMs` automatically; also public so tests can call it
   * directly with a chosen `now` instead of waiting on a real interval.
   */
  sweep(now: number = Date.now()): void {
    this.sweepBucket(this.emailFailures, now)
    this.sweepBucket(this.ipFailures, now)
  }

  /** Test-only introspection — no production code path reads bucket size. */
  emailBucketSizeForTesting(): number {
    return this.emailFailures.size
  }

  /** Test-only introspection — no production code path reads bucket size. */
  ipBucketSizeForTesting(): number {
    return this.ipFailures.size
  }

  private sweepBucket(bucket: Map<string, number[]>, now: number): void {
    for (const [key, timestamps] of bucket) {
      const pruned = pruneWindow(timestamps, now, RateLimiterService.WINDOW_MS)
      if (pruned.length === 0) bucket.delete(key)
      else if (pruned.length !== timestamps.length) bucket.set(key, pruned)
    }
  }

  private reserve(bucket: Map<string, number[]>, key: string, now: number): void {
    const pruned = pruneWindow(bucket.get(key) ?? [], now, RateLimiterService.WINDOW_MS)
    pruned.push(now)
    const trimmed = pruned.length > RateLimiterService.MAX_STORED ? pruned.slice(-RateLimiterService.MAX_STORED) : pruned
    // Delete-then-set moves the key to the end of the Map's own iteration
    // order (insertion order) — the "most recently touched" end — so
    // evictOldestIfOverCapacity below always removes the true
    // least-recently-touched key, never an arbitrary one.
    bucket.delete(key)
    bucket.set(key, trimmed)
    this.evictOldestIfOverCapacity(bucket)
  }

  private evictOldestIfOverCapacity(bucket: Map<string, number[]>): void {
    while (bucket.size > this.maxKeysPerBucket) {
      const oldestKey: string | undefined = bucket.keys().next().value
      if (oldestKey === undefined) break
      bucket.delete(oldestKey)
    }
  }
}
