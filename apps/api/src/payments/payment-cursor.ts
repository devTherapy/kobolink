/**
 * Cursor pagination for `GET /api/links/:code/payments` — the same
 * `(createdAt, tiebreaker)` keyset shape as `links/link-cursor.ts`'s
 * `LinkCursor`, but tie-broken on a payment `reference` (`kbl_...`) instead
 * of a link `code`; the two alphabets overlap but a link code is always 8
 * characters and a reference never is, so `link-cursor.ts`'s own decoder
 * would wrongly reject every real payments cursor. Opaque to the client, as
 * that file's doc comment explains.
 */
const REFERENCE_PATTERN = /^kbl_[2-9A-HJ-NP-Za-km-z]{10}$/

export interface PaymentCursor {
  createdAt: Date
  reference: string
}

interface PaymentCursorPayload {
  createdAt: string
  reference: string
}

export function encodePaymentCursor(createdAt: Date, reference: string): string {
  const payload: PaymentCursorPayload = { createdAt: createdAt.toISOString(), reference }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/** Returns `undefined` for anything that isn't a cursor this function itself produced — never throws. */
export function decodePaymentCursor(cursor: string): PaymentCursor | undefined {
  let parsed: unknown
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8')
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { createdAt, reference } = parsed as Record<string, unknown>
  if (typeof createdAt !== 'string' || typeof reference !== 'string') return undefined
  if (!REFERENCE_PATTERN.test(reference)) return undefined

  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return undefined

  return { createdAt: date, reference }
}
