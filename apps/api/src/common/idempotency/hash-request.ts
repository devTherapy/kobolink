import { createHash } from 'node:crypto'

/**
 * `idempotency_keys.request_hash` is what turns a replay with the *same*
 * `Idempotency-Key` but a *different* body into `idempotency_mismatch`
 * instead of silently returning a cached answer to a different request
 * (`packages/contracts/README.md`, "Idempotency"). B5/B8 will call this
 * once per money-moving write; it lives here now, ahead of them, because
 * it is pure logic B1's own schema decision (this column) implies, and
 * pure logic belongs in a unit test with no database, not discovered later
 * inside a handler.
 *
 * Object key order must not change the hash — `{"a":1,"b":2}` and
 * `{"b":2,"a":1}` are the same request body after `JSON.parse`, so
 * `canonicalize` sorts keys before hashing rather than hashing
 * `JSON.stringify`'s output directly.
 */
export function hashRequestBody(body: unknown): string {
  return createHash('sha256').update(canonicalize(body)).digest('hex')
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
  return `{${entries.join(',')}}`
}
