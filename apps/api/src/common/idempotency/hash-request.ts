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
 *
 * `undefined` is handled to match `JSON.stringify`'s own semantics, not
 * `String()`'s: a missing request body (`hashRequestBody(undefined)`) is
 * treated as `null`; an object key whose value is `undefined` is dropped
 * entirely, exactly as `JSON.stringify({ a: undefined })` produces `'{}'`;
 * an `undefined` array element becomes `null`, exactly as
 * `JSON.stringify([undefined])` produces `'[null]'`. Getting any of that
 * wrong is not cosmetic: `${JSON.stringify(undefined)}` in a template
 * literal silently coerces to the four-character text `"undefined"`
 * (`JSON.stringify` returns the *value* `undefined`, not a string, when
 * called on `undefined`), and passing that value straight to
 * `Hash#update()` at the top level throws instead of hashing anything.
 */
export function hashRequestBody(body: unknown): string {
  return createHash('sha256')
    .update(canonicalize(body === undefined ? null : body))
    .digest('hex')
}

function canonicalize(value: unknown): string {
  if (value === undefined) {
    // Only reachable from inside an array — an object key with an
    // undefined value is filtered out below before recursing, and the top
    // level is normalised to `null` in hashRequestBody. Arrays preserve
    // position, so, matching JSON.stringify, undefined here becomes null
    // rather than disappearing and shifting every later index.
    return 'null'
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
  return `{${entries.join(',')}}`
}
