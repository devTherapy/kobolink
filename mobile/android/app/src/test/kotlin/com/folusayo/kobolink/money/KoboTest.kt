package com.folusayo.kobolink.money

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Mirrors packages/contracts/tests/money.test.ts's formatNaira cases, so the
 * Android and web/API sides agree on what "kobo in, formatted naira out"
 * means even though this is a separate implementation.
 */
class KoboTest {
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
}
