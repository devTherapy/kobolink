package com.folusayo.kobolink.wallet

import com.folusayo.kobolink.generated.api.models.WalletTransactionListResponseItemsInner.Kind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SmallLogicTest {

    // ---- camera permission ----

    @Test
    fun `camera access - granted wins`() {
        assertEquals(CameraAccess.Granted, cameraAccess(granted = true, askedBefore = false, shouldShowRationale = false))
        assertEquals(CameraAccess.Granted, cameraAccess(granted = true, askedBefore = true, shouldShowRationale = true))
    }

    @Test
    fun `camera access - never asked is asked, not sent to settings`() {
        // Before the first prompt Android reports "no rationale" exactly as it does after "don't ask again".
        assertEquals(CameraAccess.AskFirst, cameraAccess(granted = false, askedBefore = false, shouldShowRationale = false))
    }

    @Test
    fun `camera access - denied once can be asked again`() {
        assertEquals(CameraAccess.CanAskAgain, cameraAccess(granted = false, askedBefore = true, shouldShowRationale = true))
    }

    @Test
    fun `camera access - denied for good needs settings`() {
        assertEquals(CameraAccess.Blocked, cameraAccess(granted = false, askedBefore = true, shouldShowRationale = false))
    }

    // ---- activity text ----

    @Test
    fun `signed amounts use a real minus sign and naira formatting`() {
        assertEquals("+₦1,500", signedNaira(150_000))
        assertEquals("−₦250.50", signedNaira(-25_050))
        assertEquals("₦0", signedNaira(0))
        assertEquals("+₦90,071,992,547,409.91", signedNaira(9_007_199_254_740_991L))
    }

    @Test
    fun `activity titles read as sentences`() {
        assertEquals("Sent to Ada Obi", entry("1", -100, "Ada Obi").title())
        assertEquals("Received from Chidi", entry("2", 100, "Chidi").title())
        assertEquals("Sent to a Kobolink wallet", entry("3", -100, null).title())
        assertEquals("Added to wallet", entry("4", 100, null, kind = Kind.topup).title())
        assertEquals("Payment from Ngozi", entry("5", 100, "Ngozi", kind = Kind.link_payment).title())
        assertEquals("Payment received", entry("6", 100, null, kind = Kind.link_payment).title())
    }

    @Test
    fun `direction comes from the sign of the amount`() {
        assertTrue(entry("1", -1).isOutgoing)
        assertFalse(entry("2", 1).isOutgoing)
    }

    // ---- scanned amount in the field ----

    @Test
    fun `a scanned amount fills the field as plain digits`() {
        assertEquals("2500", nairaFieldText(250_000))
        assertEquals("1500.50", nairaFieldText(150_050))
        assertEquals("10000000", nairaFieldText(1_000_000_000))
    }
}
