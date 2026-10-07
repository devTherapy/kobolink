package com.folusayo.kobolink.wallet

/**
 * Nigerian mobile numbers, mirroring `PhoneSchema` in
 * `packages/contracts/src/primitives.ts`: the user may type `0803...`,
 * `234803...` or `+234 803 ...` and the wire form is always E.164
 * (`+234XXXXXXXXXX`), which is what `POST /api/wallet/transfer` accepts as
 * `toPhone`. The server re-validates; this exists so a typo is caught on the
 * form, before a money-moving request is built.
 *
 * Pinned against the document by `NigerianPhoneTest` (the pattern) so a
 * contracts change cannot silently drift from this.
 */
object NigerianPhone {

    /** Same pattern as the OpenAPI `Phone` schema. */
    val E164_PATTERN = Regex("^\\+234[789][01][0-9]{8}$")

    private val PLUS_234 = Regex("^\\+234[0-9]{10}$")
    private val BARE_234 = Regex("^234[0-9]{10}$")
    private val LOCAL = Regex("^0[0-9]{10}$")

    /**
     * Brings `0803...`, `234803...` and `+234 803 ...` to `+234803...`.
     * Anything else is returned with whitespace and hyphens stripped, which
     * [isValid] then rejects.
     */
    fun normalize(raw: String): String {
        val compact = raw.trim().filterNot { it.isWhitespace() || it == '-' }
        return when {
            PLUS_234.matches(compact) -> compact
            BARE_234.matches(compact) -> "+$compact"
            LOCAL.matches(compact) -> "+234${compact.substring(1)}"
            else -> compact
        }
    }

    fun isValid(e164: String): Boolean = E164_PATTERN.matches(e164)

    /** `+2348031234567` -> `+234 803 123 4567`; anything else is returned unchanged. */
    fun display(e164: String): String =
        if (isValid(e164)) "+234 ${e164.substring(4, 7)} ${e164.substring(7, 10)} ${e164.substring(10)}" else e164
}
