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
    fun formatNaira(kobo: Int, alwaysShowKobo: Boolean = false): String {
        val negative = kobo < 0
        val abs = kotlin.math.abs(kobo.toLong())
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

    private fun groupedInteger(value: Long): String {
        val symbols = DecimalFormatSymbols(Locale.US).apply { groupingSeparator = ',' }
        return DecimalFormat("#,##0", symbols).format(value)
    }
}
