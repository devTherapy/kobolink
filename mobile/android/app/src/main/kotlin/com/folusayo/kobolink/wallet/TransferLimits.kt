package com.folusayo.kobolink.wallet

/**
 * The bounds `TransferRequestSchema` puts on a transfer
 * (`packages/contracts/src/wallet.ts` and `AmountKoboSchema`): ₦100 to
 * ₦10,000,000, and a note of at most 140 characters. They are advisory here
 * — the server is the authority — but checking them on the form gives a
 * field-level message instead of a failed round trip.
 *
 * `TransferLimitsTest` reads `apps/api/openapi.json` and fails if these
 * drift from the document the models are generated from.
 */
object TransferLimits {
    const val MIN_AMOUNT_KOBO: Long = 10_000
    const val MAX_AMOUNT_KOBO: Long = 1_000_000_000
    const val NOTE_MAX_LENGTH: Int = 140
}
