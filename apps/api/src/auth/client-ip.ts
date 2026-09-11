/**
 * The IP half of "rate limit per email and per IP" (PLAN.md's B2 row).
 * `X-Forwarded-For` is only trusted when `trustProxy` is true — set from
 * `TRUST_PROXY=1` (documented in `.env.example`) — because otherwise any
 * client can put whatever it likes in that header and walk straight past
 * the per-IP bucket by claiming a new address on every request. Pure
 * function of plain values (not an Express `Request`) so it is unit
 * testable with no HTTP framework involved.
 */
export interface ClientIpSource {
  /** Raw `X-Forwarded-For` header value, e.g. "203.0.113.4, 10.0.0.1" (client, then each proxy hop). */
  forwardedFor: string | undefined
  /** The actual TCP peer address — `req.socket.remoteAddress`. */
  remoteAddress: string | undefined
  trustProxy: boolean
}

const UNKNOWN_IP = 'unknown'

export function getClientIp(source: ClientIpSource): string {
  if (source.trustProxy && source.forwardedFor !== undefined) {
    // The first entry is the original client; every entry after it was
    // appended by a proxy this deployment chose to trust.
    const first = source.forwardedFor.split(',')[0]?.trim()
    if (first !== undefined && first.length > 0) return first
  }
  return source.remoteAddress ?? UNKNOWN_IP
}
