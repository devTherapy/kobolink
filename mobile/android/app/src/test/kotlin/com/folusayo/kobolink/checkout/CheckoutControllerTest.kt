package com.folusayo.kobolink.checkout

import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The checkout state machine: what the screen shows for every way the link, the network and the payer can
 * behave. Plain JVM, no Android, no real network. The fake gateway leaves calls in flight until a test
 * completes them, in whatever order the test wants.
 *
 * The first block pins the two M1 review defects this feature had to fix (items a and b):
 *
 * - tapping a link that was already handled, or whose lookup failed offline, did nothing;
 * - a late response overwrote a newer one.
 */
class CheckoutControllerTest {

    private fun TestScope.controller(gateway: FakeCheckoutGateway): CheckoutController {
        var next = 0
        return CheckoutController(gateway, backgroundScope, newIdempotencyKey = { "attempt-key-${next++}-0123456789" })
    }

    // ---- the basics -----------------------------------------------------------------------

    @Test
    fun `opening a link shows loading, then the link`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)

        assertEquals(CheckoutState.Idle, checkout.state.value)
        checkout.open("7hK2mQ9x")
        runCurrent()
        assertEquals(CheckoutState.Loading("7hK2mQ9x"), checkout.state.value)

        gateway.lookups.single().complete(found())
        runCurrent()

        assertEquals(CheckoutState.Loaded(link(), LinkAvailability.Payable), checkout.state.value)
    }

    @Test
    fun `a link the API does not know is not found`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)

        checkout.open("7hK2mQ9x")
        runCurrent()
        gateway.lookups.single().complete(LookupOutcome.NotFound)
        runCurrent()

        assertEquals(CheckoutState.NotFound("7hK2mQ9x"), checkout.state.value)
    }

    @Test
    fun `every failure kind is kept so the screen can name it`() = runTest {
        for (kind in FailureKind.entries) {
            val gateway = FakeCheckoutGateway()
            val checkout = controller(gateway)
            checkout.open("7hK2mQ9x")
            runCurrent()
            gateway.lookups.single().complete(LookupOutcome.Failed(kind))
            runCurrent()
            assertEquals(CheckoutState.LoadFailed("7hK2mQ9x", kind), checkout.state.value)
        }
    }

    @Test
    fun `a link with no readable code is the not-found checkout`() = runTest {
        val checkout = controller(FakeCheckoutGateway())
        checkout.openUnreadable()
        assertEquals(CheckoutState.NotFound(null), checkout.state.value)
        assertNull(checkout.state.value.code)
        assertTrue(checkout.state.value.isOpen)
    }

    @Test
    fun `each non-payable state is carried through unchanged`() = runTest {
        for (availability in listOf(LinkAvailability.Disabled, LinkAvailability.Expired, LinkAvailability.AlreadyPaid)) {
            val gateway = FakeCheckoutGateway()
            val checkout = controller(gateway)
            checkout.open("7hK2mQ9x")
            runCurrent()
            gateway.lookups.single().complete(found(availability = availability))
            runCurrent()
            assertEquals(CheckoutState.Loaded(link(), availability), checkout.state.value)
        }
    }

    // ---- M1 review (a): a re-tap re-runs the lookup ---------------------------------------

    @Test
    fun `tapping the link already on screen looks it up again`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)

        checkout.open("7hK2mQ9x")
        runCurrent()
        gateway.lookups[0].complete(found(link(amountKobo = 1_500_000)))
        runCurrent()

        // Same code again, as a second tap on the same message in a chat app would deliver it.
        checkout.open("7hK2mQ9x")
        runCurrent()
        assertEquals("the second tap must hit the network again", 2, gateway.lookups.size)
        assertEquals(CheckoutState.Loading("7hK2mQ9x"), checkout.state.value)

        // And what comes back is what the screen shows: the merchant repriced it in between.
        gateway.lookups[1].complete(found(link(amountKobo = 2_000_000)))
        runCurrent()
        assertEquals(CheckoutState.Loaded(link(amountKobo = 2_000_000), LinkAvailability.Payable), checkout.state.value)
    }

    @Test
    fun `tapping a link whose lookup failed offline looks it up again and recovers`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)

        checkout.open("7hK2mQ9x")
        runCurrent()
        gateway.lookups[0].complete(LookupOutcome.Failed(FailureKind.Network))
        runCurrent()
        assertEquals(CheckoutState.LoadFailed("7hK2mQ9x", FailureKind.Network), checkout.state.value)

        checkout.open("7hK2mQ9x") // back online, the payer taps the link again
        runCurrent()
        assertEquals(2, gateway.lookups.size)
        gateway.lookups[1].complete(found())
        runCurrent()

        assertEquals(CheckoutState.Loaded(link(), LinkAvailability.Payable), checkout.state.value)
    }

    @Test
    fun `reload and the retry buttons re-run the lookup for the link on screen`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        checkout.open("7hK2mQ9x")
        runCurrent()
        gateway.lookups[0].complete(found(availability = LinkAvailability.Disabled))
        runCurrent()

        checkout.reload() // "Check again"
        runCurrent()
        assertEquals(listOf("7hK2mQ9x", "7hK2mQ9x"), gateway.lookups.map { it.request })

        gateway.lookups[1].complete(found())
        runCurrent()
        assertEquals(CheckoutState.Loaded(link(), LinkAvailability.Payable), checkout.state.value)
    }

    @Test
    fun `reload with nothing open does nothing`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        checkout.reload()
        runCurrent()
        assertTrue(gateway.lookups.isEmpty())
        assertEquals(CheckoutState.Idle, checkout.state.value)
    }

    // ---- M1 review (b): the latest request wins -------------------------------------------

    @Test
    fun `a late answer for the old link cannot overwrite the new link`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)

        checkout.open("AAAAAAAA")
        runCurrent()
        checkout.open("BBBBBBBB")
        runCurrent()

        gateway.lookups[1].complete(found(link(code = "BBBBBBBB", title = "Link B")))
        runCurrent()
        assertEquals("Link B", (checkout.state.value as CheckoutState.Loaded).link.title)

        // A's answer finally arrives, long after B's.
        gateway.lookups[0].complete(found(link(code = "AAAAAAAA", title = "Link A")))
        runCurrent()

        assertEquals("Link B", (checkout.state.value as CheckoutState.Loaded).link.title)
        assertEquals("BBBBBBBB", checkout.state.value.code)
    }

    @Test
    fun `an old answer arriving while the new lookup is still pending leaves the screen loading the new one`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)

        checkout.open("AAAAAAAA")
        runCurrent()
        checkout.open("BBBBBBBB")
        runCurrent()

        gateway.lookups[0].complete(found(link(code = "AAAAAAAA", title = "Link A")))
        runCurrent()
        assertEquals(CheckoutState.Loading("BBBBBBBB"), checkout.state.value)

        gateway.lookups[1].complete(found(link(code = "BBBBBBBB", title = "Link B")))
        runCurrent()
        assertEquals("BBBBBBBB", checkout.state.value.code)
    }

    @Test
    fun `an old failure cannot replace a newer success`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)

        checkout.open("7hK2mQ9x")
        runCurrent()
        checkout.open("7hK2mQ9x") // re-tap while the first lookup is still in flight
        runCurrent()

        gateway.lookups[1].complete(found())
        runCurrent()
        gateway.lookups[0].complete(LookupOutcome.Failed(FailureKind.Network)) // the first one times out, late
        runCurrent()

        assertEquals(CheckoutState.Loaded(link(), LinkAvailability.Payable), checkout.state.value)
    }

    @Test
    fun `an answer that arrives after the checkout was closed is ignored`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)

        checkout.open("7hK2mQ9x")
        runCurrent()
        checkout.close()
        gateway.lookups.single().complete(found())
        runCurrent()

        assertEquals(CheckoutState.Idle, checkout.state.value)
    }

    // ---- paying ---------------------------------------------------------------------------

    private suspend fun TestScope.loaded(
        gateway: FakeCheckoutGateway,
        checkout: CheckoutController,
        link: CheckoutLink = link(),
        availability: LinkAvailability = LinkAvailability.Payable,
    ) {
        checkout.open(link.code)
        runCurrent()
        gateway.lookups.last().complete(found(link, availability))
        runCurrent()
    }

    @Test
    fun `pay sends the link, the payer and an idempotency key, and hands off the reference`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout)

        checkout.pay(payer)
        runCurrent()

        val (request, key) = gateway.initializes.single().request
        assertEquals(InitializeRequest("7hK2mQ9x", 1_500_000, "Tunde Bello", "tunde@example.com"), request)
        assertEquals("attempt-key-0-0123456789", key)
        assertEquals(PayPhase.Submitting, (checkout.state.value as CheckoutState.Loaded).pay)

        gateway.initializes.single().complete(InitializeOutcome.Started("kbl_abcdefghjk", 1_500_000))
        runCurrent()

        assertEquals(PayPhase.Started("kbl_abcdefghjk", 1_500_000), (checkout.state.value as CheckoutState.Loaded).pay)
    }

    @Test
    fun `a double tap on Pay is one request`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout)

        checkout.pay(payer)
        checkout.pay(payer)
        runCurrent()
        checkout.pay(payer)
        runCurrent()

        assertEquals(1, gateway.initializes.size)
    }

    @Test
    fun `pay does nothing on a link that is not payable, or before one is loaded`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        checkout.pay(payer)
        runCurrent()
        assertTrue(gateway.initializes.isEmpty())

        for (availability in listOf(LinkAvailability.Disabled, LinkAvailability.Expired, LinkAvailability.AlreadyPaid, LinkAvailability.Unknown)) {
            loaded(gateway, checkout, availability = availability)
            checkout.pay(payer)
            runCurrent()
        }
        assertTrue(gateway.initializes.isEmpty())
    }

    @Test
    fun `a retry after a failed attempt reuses the idempotency key`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout)

        checkout.pay(payer)
        runCurrent()
        gateway.initializes[0].complete(InitializeOutcome.Failed(FailureKind.Network))
        runCurrent()
        assertEquals(PayPhase.Failed(FailureKind.Network), (checkout.state.value as CheckoutState.Loaded).pay)

        checkout.pay(payer) // "Try again", same details
        runCurrent()
        gateway.initializes[1].complete(InitializeOutcome.Failed(FailureKind.Server))
        runCurrent()
        checkout.pay(payer)
        runCurrent()

        val keys = gateway.initializes.map { it.request.second }
        assertEquals(3, keys.size)
        assertEquals("one attempt, one key, however many retries", 1, keys.toSet().size)
    }

    @Test
    fun `a corrected payer is a new attempt with a new key`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout)

        checkout.pay(payer)
        runCurrent()
        gateway.initializes[0].complete(InitializeOutcome.Failed(FailureKind.Network))
        runCurrent()
        // Re-using the first key with a changed body would be idempotency_mismatch.
        checkout.pay(payer.copy(email = "tunde.bello@example.com"))
        runCurrent()

        val keys = gateway.initializes.map { it.request.second }
        assertEquals(2, keys.toSet().size)
    }

    @Test
    fun `after the server refuses a request the next attempt gets a fresh key`() = runTest {
        // The server stores a refusal under the key and replays it. If the link is switched back on and the
        // payer sends the identical request with the identical key, they would be told "turned off" again.
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout)
        payAndAnswer(
            gateway, checkout,
            InitializeOutcome.Rejected(Rejection(RejectionKind.LinkNotPayable, "no", availability = LinkAvailability.Disabled)),
        )

        loaded(gateway, checkout) // the merchant switched it back on; the payer re-taps the link
        payAndAnswer(gateway, checkout, InitializeOutcome.Started("kbl_abcdefghjk", 1_500_000))

        assertEquals(2, gateway.initializes.size)
        assertTrue(gateway.initializes[0].request.second != gateway.initializes[1].request.second)
        assertEquals(PayPhase.Started("kbl_abcdefghjk", 1_500_000), (checkout.state.value as CheckoutState.Loaded).pay)
    }

    @Test
    fun `reopening the same link keeps the attempt, a different link drops it`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout)
        checkout.pay(payer)
        runCurrent()
        gateway.initializes[0].complete(InitializeOutcome.Started("kbl_abcdefghjk", 1_500_000))
        runCurrent()

        // The payer re-taps the same link and pays again: the server replays the same reference.
        loaded(gateway, checkout)
        checkout.pay(payer)
        runCurrent()
        assertEquals(gateway.initializes[0].request.second, gateway.initializes[1].request.second)
        gateway.initializes[1].complete(InitializeOutcome.Started("kbl_abcdefghjk", 1_500_000))
        runCurrent()

        // A different link is a different attempt even with identical payer details.
        loaded(gateway, checkout, link = link(code = "Zz3Yy4Xx"))
        checkout.pay(payer)
        runCurrent()
        assertTrue(gateway.initializes[2].request.second != gateway.initializes[0].request.second)
    }

    @Test
    fun `a payment answer cannot land on a link the payer has since left`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout)
        checkout.pay(payer)
        runCurrent()

        checkout.open("Zz3Yy4Xx") // a different link is tapped while the payment request is in flight
        runCurrent()
        gateway.initializes[0].complete(InitializeOutcome.Started("kbl_abcdefghjk", 1_500_000))
        runCurrent()

        assertEquals(CheckoutState.Loading("Zz3Yy4Xx"), checkout.state.value)
    }

    @Test
    fun `closing while paying drops the answer`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout)
        checkout.pay(payer)
        runCurrent()
        checkout.close()
        gateway.initializes[0].complete(InitializeOutcome.Started("kbl_abcdefghjk", 1_500_000))
        runCurrent()
        assertEquals(CheckoutState.Idle, checkout.state.value)
    }

    // ---- refusals -------------------------------------------------------------------------

    private suspend fun TestScope.payAndAnswer(
        gateway: FakeCheckoutGateway,
        checkout: CheckoutController,
        outcome: InitializeOutcome,
    ) {
        checkout.pay(payer)
        runCurrent()
        gateway.initializes.last().complete(outcome)
        runCurrent()
    }

    @Test
    fun `losing a race for a link swaps the form for the right non-payable state`() = runTest {
        for ((named, expected) in listOf(
            LinkAvailability.Disabled to LinkAvailability.Disabled,
            LinkAvailability.AlreadyPaid to LinkAvailability.AlreadyPaid,
            LinkAvailability.Expired to LinkAvailability.Expired,
            null to LinkAvailability.Unknown,
        )) {
            val gateway = FakeCheckoutGateway()
            val checkout = controller(gateway)
            loaded(gateway, checkout)
            payAndAnswer(
                gateway, checkout,
                InitializeOutcome.Rejected(Rejection(RejectionKind.LinkNotPayable, "This link cannot be paid right now.", availability = named)),
            )
            assertEquals(CheckoutState.Loaded(link(), expected, PayPhase.Idle), checkout.state.value)
        }
    }

    @Test
    fun `a validation refusal keeps the form and carries the server's field errors`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout)
        val rejection = Rejection(
            RejectionKind.ValidationFailed, "Validation failed.",
            fieldErrors = mapOf(PayerField.Email to "Invalid email address"), moneyMoved = null,
        )
        payAndAnswer(gateway, checkout, InitializeOutcome.Rejected(rejection))

        assertEquals(
            PayPhase.Rejected("Validation failed.", mapOf(PayerField.Email to "Invalid email address"), null),
            (checkout.state.value as CheckoutState.Loaded).pay,
        )
    }

    @Test
    fun `a repriced fixed-amount link is re-read and the new price shown`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout, link(amountKobo = 1_500_000))

        checkout.pay(payer)
        runCurrent()
        gateway.initializes[0].complete(InitializeOutcome.Rejected(Rejection(RejectionKind.AmountMismatch, "That amount does not match this link.")))
        runCurrent()
        // Re-reading the link, not guessing:
        assertEquals(2, gateway.lookups.size)
        gateway.lookups[1].complete(found(link(amountKobo = 1_800_000)))
        runCurrent()

        assertEquals(
            CheckoutState.Loaded(link(amountKobo = 1_800_000), LinkAvailability.Payable, PayPhase.PriceChanged(1_800_000)),
            checkout.state.value,
        )
    }

    @Test
    fun `a repriced link whose re-read fails still says the price changed`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout, link(amountKobo = 1_500_000))

        checkout.pay(payer)
        runCurrent()
        gateway.initializes[0].complete(InitializeOutcome.Rejected(Rejection(RejectionKind.AmountMismatch, "mismatch")))
        runCurrent()
        gateway.lookups[1].complete(LookupOutcome.Failed(FailureKind.Network))
        runCurrent()

        assertEquals(PayPhase.PriceChanged(null), (checkout.state.value as CheckoutState.Loaded).pay)
    }

    @Test
    fun `a link switched off while repricing shows the non-payable state, not a price message`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout)

        checkout.pay(payer)
        runCurrent()
        gateway.initializes[0].complete(InitializeOutcome.Rejected(Rejection(RejectionKind.AmountMismatch, "mismatch")))
        runCurrent()
        gateway.lookups[1].complete(found(availability = LinkAvailability.Disabled))
        runCurrent()

        assertEquals(CheckoutState.Loaded(link(), LinkAvailability.Disabled, PayPhase.Idle), checkout.state.value)
    }

    @Test
    fun `an amount refused on an open-amount link is a field error on the amount`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout, link(amountKobo = null))

        payAndAnswer(
            gateway, checkout,
            InitializeOutcome.Rejected(Rejection(RejectionKind.AmountMismatch, "That amount does not match this link.")),
        )

        val pay = (checkout.state.value as CheckoutState.Loaded).pay as PayPhase.Rejected
        assertEquals(mapOf(PayerField.Amount to "That amount does not match this link."), pay.fieldErrors)
        assertEquals(1, gateway.lookups.size) // no re-read: the typed amount was the problem
    }
}
