/**
 * Sliding-window arithmetic for the login rate limiter — pure functions of
 * an array of failure timestamps (milliseconds since epoch), `now`, a
 * window size and a limit. No I/O, no class, no Map: `RateLimiterService`
 * (in-memory storage, see its own doc comment for why in-memory over
 * Postgres) is the thin, untested-by-itself wrapper that owns the actual
 * `Map<string, number[]>` and calls these.
 */

/** Drops every timestamp older than `windowMs` relative to `now`. Preserves insertion order (oldest first), which `checkWindow` relies on. */
export function pruneWindow(timestamps: readonly number[], now: number, windowMs: number): number[] {
  return timestamps.filter((timestamp) => now - timestamp < windowMs)
}

export interface WindowCheck {
  allowed: boolean
  /** Seconds until the oldest timestamp in the window ages out and a new attempt would be allowed again. 0 when `allowed`. */
  retryAfterSeconds: number
  /** The pruned count, for callers that want it (e.g. logging). */
  count: number
}

/**
 * `allowed` is `pruned.length < limit` — i.e. `limit` failures are
 * tolerated and the `(limit + 1)`th within the window is the one that
 * trips it. `retryAfterSeconds` is measured from the *oldest* surviving
 * timestamp, since that is the one that will next age out of the window
 * and free up a slot.
 */
export function checkWindow(timestamps: readonly number[], now: number, windowMs: number, limit: number): WindowCheck {
  const pruned = pruneWindow(timestamps, now, windowMs)
  const allowed = pruned.length < limit
  const oldest = pruned[0]
  const retryAfterSeconds =
    allowed || oldest === undefined ? 0 : Math.max(0, Math.ceil((oldest + windowMs - now) / 1000))
  return { allowed, retryAfterSeconds, count: pruned.length }
}
