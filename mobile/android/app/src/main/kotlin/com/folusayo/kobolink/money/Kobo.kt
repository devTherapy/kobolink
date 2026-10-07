package com.folusayo.kobolink.money

import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.util.Locale

/**
 * Money is ALWAYS an integer number of kobo — never a float, never naira.
 * This mirrors the non-negotiable in `packages/contracts/src/money.ts`
 * (KOBO_PER_NAIRA, formatNaira): that file is the only place on the web/API
 * side allowed to divide or multiply by 100, and this object is that same
 * single exception on the Android side. Generated models
 * (`PublicLink.amountKobo`, `PaymentLink.amountKobo`, ...) carry kobo
 * untouched; every screen formats only at the final display step, by
 * calling [formatNaira] here — never by doing its own `/ 100`.
 */
object Kobo {
    const val PER_NAIRA = 100

    private const val NAIRA_SIGN = "₦"

    /**
     * Render kobo as naira for display: 1_850_000 -> "₦18,500". Shows the
     * kobo remainder only when it is non-zero, or when [alwaysShowKobo] asks
     * for it — same rule as `formatNaira` in packages/contracts.
     */
    fun formatNaira(kobo: Int, alwaysShowKobo: Boolean = false): String =
        formatNaira(kobo.toLong(), alwaysShowKobo)

    /**
     * Same as the [Int] overload, for amounts that can pass 2^31-1 kobo: a
     * wallet balance is a ledger sum, bounded by contracts at
     * `Number.MAX_SAFE_INTEGER`, and the generated models carry it as a Long.
     */
    fun formatNaira(kobo: Long, alwaysShowKobo: Boolean = false): String {
        val negative = kobo < 0
        val abs = kotlin.math.abs(kobo)
        val whole = abs / PER_NAIRA
        val remainder = (abs % PER_NAIRA).toInt()

        val groupedWhole = groupedInteger(whole)
        val body = if (alwaysShowKobo || remainder != 0) {
            "$groupedWhole.${remainder.toString().padStart(2, '0')}"
        } else {
            groupedWhole
        }

        return "${if (negative) "-" else ""}$NAIRA_SIGN$body"
    }

    private val NAIRA_INPUT = Regex("^([0-9]{1,13})(?:\\.([0-9]{1,2}))?$")

    /**
     * The inverse of [formatNaira], for what a person types into an amount
     * field: `1500`, `1,500`, `₦1,500.5`, `0.50`. Returns kobo, or null when
     * the text is not a naira amount with at most two decimal places (so
     * `1.234`, `1e3`, `-5`, `12abc`, and the empty string are all null —
     * never a silently rounded or truncated amount). This is the one place
     * that multiplies by 100 on the Android side.
     */
    fun parseNaira(input: String): Long? {
        val cleaned = input.trim().removePrefix(NAIRA_SIGN).filterNot { it.isWhitespace() || it == ',' }
        val match = NAIRA_INPUT.matchEntire(cleaned) ?: return null
        val whole = match.groupValues[1].toLong()
        val fraction = match.groupValues[2].padEnd(2, '0').toInt()
        return whole * PER_NAIRA + fraction
    }

    private fun groupedInteger(value: Long): String {
        val symbols = DecimalFormatSymbols(Locale.US).apply { groupingSeparator = ',' }
        return DecimalFormat("#,##0", symbols).format(value)
    }
}
