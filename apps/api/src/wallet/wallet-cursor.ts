/**
 * Cursor pagination for `GET /api/wallet/transactions` — the same
 * `(createdAt, tiebreaker)` opaque keyset shape as `links/link-cursor.ts`'s
 * `LinkCursor` and `payments/payment-cursor.ts`'s `PaymentCursor`, tied
 * off on a `ledger_entries.id` (a nanoid — see `db/schema/id.ts`) rather
 * than a link code or a `kbl_...` payment reference: each row in this list
 * is one `ledger_entries` row for the caller's own wallet account (never
 * more than one entry per posting on the *same* account — a transfer's two
 * legs are always two different accounts, so this account's own entry id
 * is already a total order's tiebreaker without needing the posting's own
 * id too).
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export interface WalletCursor {
  createdAt: Date
  entryId: string
}

interface WalletCursorPayload {
  createdAt: string
  entryId: string
}

export function encodeWalletCursor(createdAt: Date, entryId: string): string {
  const payload: WalletCursorPayload = { createdAt: createdAt.toISOString(), entryId }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/** Returns `undefined` for anything that isn't a cursor this function itself produced — never throws. */
export function decodeWalletCursor(cursor: string): WalletCursor | undefined {
  let parsed: unknown
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8')
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { createdAt, entryId } = parsed as Record<string, unknown>
  if (typeof createdAt !== 'string' || typeof entryId !== 'string') return undefined
  if (!ID_PATTERN.test(entryId)) return undefined

  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return undefined

  return { createdAt: date, entryId }
}
