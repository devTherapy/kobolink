import { type QrPayload, QR_PAYLOAD_VERSION, QrPayloadSchema } from '@kobolink/contracts'

/**
 * "Scan to pay"/"scan to receive": a `QrPayload` (`packages/contracts/src/
 * wallet.ts`, already defined — B8 implements against it, never invents its
 * own shape) is nothing but the receiving user's own `phone`/`displayName`
 * plus an optional requested amount. Nothing here calls the database or an
 * HTTP boundary — encoding it needs no server round trip at all: any client
 * that already has its own user (`GET /api/auth/me`, `MeResponse.user`) can
 * build one locally. This function exists so that encode/validate logic is
 * written once, pure and unit-tested, ready for whichever caller
 * (`packages/contracts/src/routes.ts`'s `API.wallet` has no path for this
 * today — see this PR's description) ends up needing it.
 *
 * The *paying* side of the flow needs no new endpoint either: decoding a
 * scanned `QrPayload` yields exactly `{toPhone, amountKobo}`, the two
 * fields `POST /api/wallet/transfer` (`TransferRequestSchema`) already
 * accepts.
 *
 * Throws if `user.phone` is null — the same E.164 phone number
 * `TransferRequestSchema.toPhone` uses to find a recipient
 * (`users_phone_unique`), so a user with no phone on file has no way for
 * anyone to send them money by scanning a code in the first place.
 */
export function buildQrPayload(user: { phone: string | null; displayName: string }, amountKobo: number | null): QrPayload {
  if (user.phone === null) {
    throw new Error('qr-payload: cannot build a QrPayload for a user with no phone number on file')
  }
  return QrPayloadSchema.parse({
    v: QR_PAYLOAD_VERSION,
    toPhone: user.phone,
    displayName: user.displayName,
    amountKobo,
  })
}
