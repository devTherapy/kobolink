package com.folusayo.kobolink.checkout

import java.io.File
import java.time.OffsetDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CheckoutCopyTest {

    private val ada = link(merchantName = "Ada's Bakery")

    // ---- the non-payable deck is the web deck ---------------------------------------------

    /**
     * `NON_PAYABLE_COPY` in apps/web/src/lib/checkout.ts is what the web checkout says for a link that cannot
     * be paid. The app must not say it differently, so every sentence here is looked for, verbatim, in that file
     * (the merchant's name standing in for the template's `${link.merchantName}`).
     */
    @Test
    fun `says what the web checkout says for every non-payable state`() {
        val web = File("../../../apps/web/src/lib/checkout.ts").also {
            check(it.exists()) { "expected ${it.absolutePath}; this test reads the web copy off disk" }
        }.readText()
        val merchant = "MERCHANT"
        val sample = link(merchantName = merchant, expiresAt = null)

        for (availability in listOf(LinkAvailability.Disabled, LinkAvailability.Expired, LinkAvailability.AlreadyPaid)) {
            val notice = nonPayableNotice(availability, sample)
            for (sentence in listOfNotNull(notice.heading, notice.body, notice.nextStep)) {
                val asTemplate = sentence.replace(merchant, "\${link.merchantName}")
                assertTrue("web copy has no `$asTemplate` for $availability", web.contains(asTemplate))
            }
        }
        // The dated variant: same sentence up to the date.
        assertTrue(web.contains("This payment link expired on "))
        // The money line lives in the component, not the deck.
        val screen = File("../../../apps/web/src/components/checkout/NonPayableScreen.tsx").readText()
        assertTrue(screen.contains(NO_MONEY_MOVED))
        // ...and so does the neutral copy for a refusal that named no state.
        val unknown = nonPayableNotice(LinkAvailability.Unknown, sample)
        assertTrue(screen.contains(unknown.heading))
        assertTrue(screen.contains(unknown.nextStep))
    }

    @Test
    fun `every notice says whether money moved`() {
        val notices = listOf(
            nonPayableNotice(LinkAvailability.Disabled, ada),
            nonPayableNotice(LinkAvailability.Expired, ada),
            nonPayableNotice(LinkAvailability.AlreadyPaid, ada),
            nonPayableNotice(LinkAvailability.Unknown, ada),
            notFoundNotice(),
        ) + FailureKind.entries.map(::loadFailedNotice)
        for (notice in notices) {
            assertEquals(NO_MONEY_MOVED, notice.moneyLine)
            assertTrue("${notice.heading} needs a next step", notice.nextStep.isNotBlank())
        }
    }

    @Test
    fun `an expired link names the deadline in Lagos time with the zone spelled out`() {
        val expiresAt = OffsetDateTime.parse("2026-10-07T16:00:00+00:00") // 17:00 in Lagos
        val body = nonPayableNotice(LinkAvailability.Expired, link(expiresAt = expiresAt)).body
        assertEquals("This payment link expired on 7 Oct 2026, 5:00 PM WAT.", body)
    }

    @Test
    fun `the deadline reads the same whatever offset it arrived with`() {
        val a = formatCheckoutDate(OffsetDateTime.parse("2026-10-07T17:00:00+01:00"))
        val b = formatCheckoutDate(OffsetDateTime.parse("2026-10-07T12:00:00-04:00"))
        assertEquals(a, b)
    }

    @Test
    fun `an expired link with no date still says it expired`() {
        assertEquals("This payment link has expired.", nonPayableNotice(LinkAvailability.Expired, link(expiresAt = null)).body)
    }

    @Test
    fun `an unspecified refusal is worded neutrally, not as a merchant action nobody confirmed`() {
        val notice = nonPayableNotice(LinkAvailability.Unknown, ada)
        assertEquals("This link cannot be paid right now", notice.heading)
        assertEquals(null, notice.body)
        assertFalse(notice.heading.contains("off"))
    }

    // ---- failures name what went wrong ----------------------------------------------------

    @Test
    fun `each failure kind names its cause differently`() {
        val sentences = FailureKind.entries.map { loadFailedNotice(it).body }
        assertEquals(FailureKind.entries.size, sentences.toSet().size)
    }

    @Test
    fun `a failed payment attempt says it could not confirm the start and that no money moved`() {
        for (kind in FailureKind.entries) {
            val message = payFailureMessage(kind)
            assertTrue(message, message.contains("could not confirm that your payment started"))
            assertTrue(message, message.endsWith(NO_MONEY_MOVED))
        }
    }

    @Test
    fun `a refusal adds the money line unless the server says money moved`() {
        assertEquals("Nope. No money has moved.", rejectionMessage("Nope.", moneyMoved = null))
        assertEquals("Nope. No money has moved.", rejectionMessage("Nope.", moneyMoved = false))
        assertEquals("Nope.", rejectionMessage("Nope.", moneyMoved = true))
    }

    @Test
    fun `field-level refusals point at the fields instead of repeating the server's generic message`() {
        assertEquals("Check the highlighted fields. No money has moved.", rejectionBanner("Validation failed.", true, null))
        assertEquals("That amount does not match this link. No money has moved.", rejectionBanner("That amount does not match this link.", false, null))
    }

    @Test
    fun `a price change quotes the new price from integer kobo`() {
        assertEquals(
            "The price of this link changed to ₦18,000. Check it, then pay again. No money has moved.",
            priceChangedMessage(1_800_000),
        )
        assertTrue(priceChangedMessage(null).contains("changed"))
        assertTrue(priceChangedMessage(null).endsWith(NO_MONEY_MOVED))
    }

    // ---- the button -----------------------------------------------------------------------

    @Test
    fun `the pay button names the amount once it is known`() {
        assertEquals(ButtonLabel("Pay ₦15,000", "Pay 15,000 naira"), payButtonLabel(1_500_000, "", retry = false))
        assertEquals(ButtonLabel("Pay ₦2,500.50", "Pay 2,500 naira, 50 kobo"), payButtonLabel(null, "2,500.50", retry = false))
    }

    @Test
    fun `the pay button says plain Pay while an open amount is blank or not chargeable`() {
        assertEquals("Pay", payButtonLabel(null, "", retry = false).text)
        assertEquals("Pay", payButtonLabel(null, "5", retry = false).text) // below the ₦100 minimum
        assertEquals("Pay", payButtonLabel(null, "99999999", retry = false).text) // above the ₦10,000,000 cap
        assertEquals("Pay", payButtonLabel(null, "abc", retry = false).text)
    }

    @Test
    fun `after a failure the button says try again`() {
        assertEquals("Try again", payButtonLabel(1_500_000, "", retry = true).text)
    }

    // ---- small helpers --------------------------------------------------------------------

    @Test
    fun `the avatar letter is the first character, not half of an emoji`() {
        assertEquals("A", merchantInitial("Ada's Bakery"))
        assertEquals("A", merchantInitial("  ada"))
        assertEquals("🍞", merchantInitial("🍞 Bread Co"))
        assertEquals("?", merchantInitial("   "))
    }

    @Test
    fun `a reference is spelled out for a screen reader`() {
        assertEquals("k b l underscore a b 3", spelledOut("kbl_ab3"))
    }
}
