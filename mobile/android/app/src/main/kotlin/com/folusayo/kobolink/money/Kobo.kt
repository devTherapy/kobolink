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

    /** Largest amount a single payment link may carry: ₦10,000,000. Mirrors `MAX_AMOUNT_KOBO`. */
    const val MAX_AMOUNT_KOBO = 10_000_000 * PER_NAIRA

    /** Smallest chargeable amount: ₦100. Mirrors `MIN_AMOUNT_KOBO`. */
    const val MIN_AMOUNT_KOBO = 100 * PER_NAIRA

    /** Is this a chargeable amount for a payment link? Mirrors `isValidAmountKobo`. */
    fun isValidAmountKobo(kobo: Int): Boolean = kobo in MIN_AMOUNT_KOBO..MAX_AMOUNT_KOBO

    /**
     * Parse what a payer typed into kobo. Accepts "18500", "18,500", "₦18,500",
     * "18500.50" — same rule as `parseNaira` in packages/contracts. Returns null for
     * anything it cannot read exactly, never a guess.
     *
     * One difference of type, not of rule: contracts returns any JS safe integer and
     * leaves the range to [isValidAmountKobo]; here a value that does not fit an
     * [Int] of kobo is also null, which every caller already treats as "not a
     * chargeable amount" (the cap is ₦10,000,000, far below `Int.MAX_VALUE`).
     */
    fun parseNaira(input: String): Int? {
        val cleaned = input.trim().filterNot { it == '₦' || it == ',' || it.isWhitespace() }
        if (!PARSEABLE.matches(cleaned)) return null

        val negative = cleaned.startsWith('-')
        val unsigned = cleaned.removePrefix("-")
        val whole = unsigned.substringBefore('.').toLongOrNull() ?: return null
        // Refuse before multiplying: whole * 100 wraps a Long for large input and can land on a small, valid-looking
        // amount. Anything above this cannot be an Int of kobo anyway.
        if (whole > Int.MAX_VALUE / PER_NAIRA) return null
        val fraction = unsigned.substringAfter('.', "").padEnd(2, '0').toLong()

        val kobo = whole * PER_NAIRA + fraction
        val signed = if (negative) -kobo else kobo
        return signed.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()
    }

    /**
     * The amount as a screen reader should say it. TalkBack reads "₦" inconsistently
     * (often "naira sign", sometimes nothing), so the visible "₦18,500.50" is paired
     * with "18,500 naira, 50 kobo" as its accessibility label.
     */
    fun spokenNaira(kobo: Int): String {
        val negative = kobo < 0
        val abs = kotlin.math.abs(kobo.toLong())
        val whole = groupedInteger(abs / PER_NAIRA)
        val remainder = (abs % PER_NAIRA).toInt()
        val body = if (remainder == 0) "$whole naira" else "$whole naira, $remainder kobo"
        return if (negative) "minus $body" else body
    }

    private val PARSEABLE = Regex("""^-?\d+(\.\d{1,2})?$""")

    private fun groupedInteger(value: Long): String {
        val symbols = DecimalFormatSymbols(Locale.US).apply { groupingSeparator = ',' }
        return DecimalFormat("#,##0", symbols).format(value)
    }
}
