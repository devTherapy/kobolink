import { isValidLinkCode } from '@kobolink/contracts'

/**
 * Cursor pagination for `GET /api/links` (and, in the same shape, the
 * payments list once B5 lands): an opaque base64url blob of the last row's
 * `(createdAt, code)` keyset, per `packages/contracts/README.md`'s
 * `links.collection` row. Opaque to the client on purpose — nothing about
 * the encoding is part of the contract, only that a `nextCursor` handed back
 * by the API is later accepted back by the API.
 *
 * `code` breaks ties within the same millisecond so the keyset walk is
 * total: `createdAt` alone is not unique (Postgres `timestamptz` has
 * microsecond resolution, but two links can still share a millisecond once
 * truncated to what `toIso`/`toISOString`/`IsoDateTimeSchema` carries), and
 * `code` — the primary key — always is.
 *
 * That truncation is exactly why `LinksService.list`'s keyset predicate
 * compares `date_trunc('milliseconds', links.created_at)` — never the bare
 * column — against this cursor's `createdAt`, and orders by that same
 * truncated expression rather than the raw column: a cursor built from
 * `encodeLinkCursor(last.createdAt, ...)` only ever carries millisecond
 * precision (a JS `Date` cannot hold more), so comparing it against the
 * full microsecond-precision column let a row that shared the last row's
 * millisecond but had smaller microseconds fail both `<` and `=` against
 * the truncated cursor value and vanish from the next page — the `code`
 * tie-break only ever fired when the stored microseconds happened to be
 * exactly `000`. Truncating both sides of the comparison (and the order
 * itself) to the same millisecond precision the cursor encodes is what
 * makes `code` the tie-break `LinksService`'s query actually relies on.
 */
export interface LinkCursor {
  createdAt: Date
  code: string
}

interface LinkCursorPayload {
  createdAt: string
  code: string
}

export function encodeLinkCursor(createdAt: Date, code: string): string {
  const payload: LinkCursorPayload = { createdAt: createdAt.toISOString(), code }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/** Returns `undefined` for anything that isn't a cursor this function itself produced — never throws. */
export function decodeLinkCursor(cursor: string): LinkCursor | undefined {
  let parsed: unknown
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8')
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { createdAt, code } = parsed as Record<string, unknown>
  if (typeof createdAt !== 'string' || typeof code !== 'string') return undefined
  if (!isValidLinkCode(code)) return undefined

  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return undefined

  return { createdAt: date, code }
}
