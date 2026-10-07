package com.folusayo.kobolink.money

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [Kobo] is the Android side's one place that may divide or multiply by 100,
 * the mirror of `packages/contracts/src/money.ts`. The cases below are the
 * cases in `packages/contracts/tests/money.test.ts`, one for one, so the two
 * sides agree on what "kobo in, formatted naira out" and "text in, kobo out"
 * mean even though they are separate implementations. Where a TypeScript case
 * has no Kotlin equivalent, it says why.
 */
class KoboTest {

    // ---- formatNaira: money.test.ts `describe('formatNaira')` -------------------------------

    @Test
    fun `renders whole naira without a decimal part`() {
        assertEquals("₦18,500", Kobo.formatNaira(1_850_000))
        assertEquals("₦0", Kobo.formatNaira(0))
    }

    @Test
    fun `shows kobo only when there is a remainder`() {
        assertEquals("₦18,500.50", Kobo.formatNaira(1_850_050))
        assertEquals("₦18,500.05", Kobo.formatNaira(1_850_005))
        assertEquals("₦18,500.00", Kobo.formatNaira(1_850_000, alwaysShowKobo = true))
    }

    @Test
    fun `handles negatives`() {
        assertEquals("-₦18,500", Kobo.formatNaira(-1_850_000))
    }

    // contracts' "refuses a float rather than silently rounding it" has no Kotlin case: the
    // parameter is an Int, so a float cannot reach formatNaira without a compile error.

    @Test
    fun `formats the largest chargeable amount`() {
        assertEquals("₦10,000,000", Kobo.formatNaira(Kobo.MAX_AMOUNT_KOBO))
        assertEquals("₦100", Kobo.formatNaira(Kobo.MIN_AMOUNT_KOBO))
    }

    // ---- parseNaira: money.test.ts `describe('parseNaira')` ---------------------------------

    @Test
    fun `parses what a payer types`() {
        val cases = listOf(
            "18500" to 1_850_000,
            "18,500" to 1_850_000,
            "₦18,500" to 1_850_000,
            " ₦18,500 " to 1_850_000,
            "18500.5" to 1_850_050,
            "18500.05" to 1_850_005,
            "0" to 0,
        )
        for ((input, expected) in cases) {
            assertEquals("parseNaira($input)", expected, Kobo.parseNaira(input))
        }
    }

    @Test
    fun `rejects what it cannot read exactly rather than guessing`() {
        for (input in listOf("", "abc", "18,50 0.123", "1.2.3", "₦", "18500.123", "--5")) {
            assertNull("parseNaira($input) should be null", Kobo.parseNaira(input))
        }
    }

    @Test
    fun `round-trips through formatNaira`() {
        for (kobo in listOf(0, 100, 1_850_000, 1_850_050, 999_999_99)) {
            assertEquals(kobo, Kobo.parseNaira(Kobo.formatNaira(kobo, alwaysShowKobo = true)))
        }
    }

    @Test
    fun `a value too large for an Int of kobo is unreadable, not wrapped around`() {
        // 21,474,836.48 naira is Int.MAX_VALUE + 1 kobo. A wrapped value here would be a
        // negative amount; null makes the caller say "not a chargeable amount".
        assertNull(Kobo.parseNaira("21474836.48"))
        assertNull(Kobo.parseNaira("99999999999999999999"))
    }

    @Test
    fun `a negative parses and is left for the range check to refuse`() {
        assertEquals(-500, Kobo.parseNaira("-5"))
        assertFalse(Kobo.isValidAmountKobo(-500))
    }

    // ---- isValidAmountKobo: money.test.ts `describe('isValidAmountKobo')` --------------------

    @Test
    fun `accepts the boundaries`() {
        assertTrue(Kobo.isValidAmountKobo(Kobo.MIN_AMOUNT_KOBO))
        assertTrue(Kobo.isValidAmountKobo(Kobo.MAX_AMOUNT_KOBO))
    }

    @Test
    fun `rejects outside them`() {
        assertFalse(Kobo.isValidAmountKobo(Kobo.MIN_AMOUNT_KOBO - 1))
        assertFalse(Kobo.isValidAmountKobo(Kobo.MAX_AMOUNT_KOBO + 1))
    }

    // ---- the constants are the contracts' constants -----------------------------------------

    @Test
    fun `the limits are the ones in packages-contracts money-ts`() {
        val source = File("../../../packages/contracts/src/money.ts").also {
            check(it.exists()) { "expected ${it.absolutePath}; this test reads the contracts package off disk" }
        }.readText()

        assertEquals(constant(source, "KOBO_PER_NAIRA").toInt(), Kobo.PER_NAIRA)
        // MAX/MIN are written as `10_000_000 * KOBO_PER_NAIRA` and `100 * KOBO_PER_NAIRA` there.
        assertEquals(
            Regex("""MAX_AMOUNT_KOBO = ([\d_]+) \* KOBO_PER_NAIRA""").find(source)!!.groupValues[1].replace("_", "").toInt() * Kobo.PER_NAIRA,
            Kobo.MAX_AMOUNT_KOBO,
        )
        assertEquals(
            Regex("""MIN_AMOUNT_KOBO = ([\d_]+) \* KOBO_PER_NAIRA""").find(source)!!.groupValues[1].replace("_", "").toInt() * Kobo.PER_NAIRA,
            Kobo.MIN_AMOUNT_KOBO,
        )
    }

    private fun constant(source: String, name: String): String =
        checkNotNull(Regex("""export const $name = ([\d_]+)""").find(source)) { "no $name in money.ts" }
            .groupValues[1].replace("_", "")

    // ---- spoken form (TalkBack) -------------------------------------------------------------

    @Test
    fun `speaks amounts in words rather than relying on the naira sign`() {
        assertEquals("18,500 naira", Kobo.spokenNaira(1_850_000))
        assertEquals("18,500 naira, 50 kobo", Kobo.spokenNaira(1_850_050))
        assertEquals("18,500 naira, 5 kobo", Kobo.spokenNaira(1_850_005))
        assertEquals("0 naira", Kobo.spokenNaira(0))
        assertEquals("minus 100 naira", Kobo.spokenNaira(-10_000))
    }

    // ---- the non-negotiable, enforced -------------------------------------------------------

    @Test
    fun `no other file in the app divides or multiplies by 100`() {
        val offenders = File("src/main/kotlin").walkTopDown()
            .filter { it.isFile && it.extension == "kt" && it.name != "Kobo.kt" }
            .flatMap { file ->
                file.readLines().withIndex()
                    .filter { (_, line) -> Regex("""[/*]\s*100(\.0|L|f)?\b|\b100(\.0|L|f)?\s*[/*]""").containsMatchIn(line.substringBefore("//")) }
                    .map { (index, line) -> "${file.name}:${index + 1}: ${line.trim()}" }
            }
            .toList()
        assertTrue("only money/Kobo.kt may do kobo arithmetic, found: $offenders", offenders.isEmpty())
    }
}
