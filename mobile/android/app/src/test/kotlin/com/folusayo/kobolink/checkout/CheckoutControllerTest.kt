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

    // ---- M3 review (b): each half of latest-wins, on its own ---------------------------------
    //
    // "Latest wins" is two mechanisms: Job.cancel() abandons the old request, and the generation check drops an
    // answer that arrives anyway. Each test below fails if exactly one of them is removed. The all-purpose tests
    // above cannot tell: either mechanism alone makes them pass.

    @Test
    fun `a superseded lookup is cancelled, not merely ignored`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)

        checkout.open("AAAAAAAA")
        runCurrent()
        checkout.open("BBBBBBBB")
        runCurrent()

        assertTrue("the request for the old link must be abandoned", gateway.lookups[0].cancelled)
        assertEquals("the request for the new link must keep running", false, gateway.lookups[1].cancelled)
    }

    @Test
    fun `closing cancels the lookup in flight`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        checkout.open("7hK2mQ9x")
        runCurrent()

        checkout.close()
        runCurrent()

        assertTrue(gateway.lookups.single().cancelled)
    }

    @Test
    fun `leaving a link while its payment request is in flight cancels that request`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout)
        checkout.pay(payer)
        runCurrent()

        checkout.open("Zz3Yy4Xx")
        runCurrent()

        assertTrue(gateway.initializes.single().cancelled)
    }

    @Test
    fun `a lookup answer that arrives despite cancellation still cannot overwrite the newer link`() = runTest {
        val gateway = FakeCheckoutGateway(ignoreCancellation = true)
        val checkout = controller(gateway)

        checkout.open("AAAAAAAA")
        runCurrent()
        checkout.open("BBBBBBBB")
        runCurrent()
        gateway.lookups[1].complete(found(link(code = "BBBBBBBB", title = "Link B")))
        runCurrent()

        // A's call does not notice it was cancelled and hands back its answer anyway.
        gateway.lookups[0].complete(found(link(code = "AAAAAAAA", title = "Link A")))
        runCurrent()

        assertEquals("Link B", (checkout.state.value as CheckoutState.Loaded).link.title)
    }

    @Test
    fun `an answer that arrives despite cancellation cannot reopen a closed checkout`() = runTest {
        val gateway = FakeCheckoutGateway(ignoreCancellation = true)
        val checkout = controller(gateway)
        checkout.open("7hK2mQ9x")
        runCurrent()
        checkout.close()

        gateway.lookups.single().complete(found())
        runCurrent()

        assertEquals(CheckoutState.Idle, checkout.state.value)
    }

    @Test
    fun `a payment answer that arrives despite cancellation cannot land on the link the payer moved to`() = runTest {
        val gateway = FakeCheckoutGateway(ignoreCancellation = true)
        val checkout = controller(gateway)
        loaded(gateway, checkout)
        checkout.pay(payer)
        runCurrent()
        checkout.open("Zz3Yy4Xx")
        runCurrent()

        gateway.initializes[0].complete(InitializeOutcome.Started("kbl_abcdefghjk", 1_500_000))
        runCurrent()

        assertEquals(CheckoutState.Loading("Zz3Yy4Xx"), checkout.state.value)
    }

    @Test
    fun `a stale re-read after a price change cannot replace the link the payer moved to`() = runTest {
        val gateway = FakeCheckoutGateway(ignoreCancellation = true)
        val checkout = controller(gateway)
        loaded(gateway, checkout)
        checkout.pay(payer)
        runCurrent()
        gateway.initializes[0].complete(InitializeOutcome.Rejected(Rejection(RejectionKind.AmountMismatch, "mismatch")))
        runCurrent() // the controller is now re-reading the price: lookups[1]

        checkout.open("Zz3Yy4Xx")
        runCurrent()
        gateway.lookups[1].complete(found(link(amountKobo = 1_800_000)))
        runCurrent()

        assertEquals(CheckoutState.Loading("Zz3Yy4Xx"), checkout.state.value)
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
        assertEquals(
            PayPhase.Failed(FailureKind.Network, InitializeRequest("7hK2mQ9x", 1_500_000, "Tunde Bello", "tunde@example.com")),
            (checkout.state.value as CheckoutState.Loaded).pay,
        )

        checkout.retry() // "Try again": the attempt screen has no form, the stored request is sent again
        runCurrent()
        gateway.initializes[1].complete(InitializeOutcome.Failed(FailureKind.Server))
        runCurrent()
        checkout.retry()
        runCurrent()

        val keys = gateway.initializes.map { it.request.second }
        assertEquals(3, keys.size)
        assertEquals("one attempt, one key, however many retries", 1, keys.toSet().size)
        assertEquals("and the identical request each time", 1, gateway.initializes.map { it.request.first }.toSet().size)
    }

    @Test
    fun `after a failure the payer cannot send a corrected request, the first key is the only one`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout)

        checkout.pay(payer)
        runCurrent()
        gateway.initializes[0].complete(InitializeOutcome.Failed(FailureKind.Network))
        runCurrent()
        // The first POST may have created a pending checkout under its key. Replacing the key (or the request under
        // it) is a second checkout for one payment, so there is no form to correct and nothing to send.
        checkout.pay(payer.copy(email = "tunde.bello@example.com"))
        runCurrent()

        assertEquals(1, gateway.initializes.size)
        assertTrue((checkout.state.value as CheckoutState.Loaded).pay is PayPhase.Failed)
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
    fun `a failed attempt keeps its key across a re-tap of the same link, a different link drops it`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout)
        checkout.pay(payer)
        runCurrent()
        gateway.initializes[0].complete(InitializeOutcome.Failed(FailureKind.Network))
        runCurrent()

        // The request may or may not have been processed: the retry must carry the same key.
        loaded(gateway, checkout)
        checkout.retry()
        runCurrent()
        assertEquals(gateway.initializes[0].request.second, gateway.initializes[1].request.second)
        gateway.initializes[1].complete(InitializeOutcome.Failed(FailureKind.Network))
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

    @Test
    fun `a link deleted while the payer was on the form becomes the not-found screen`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout)
        payAndAnswer(gateway, checkout, InitializeOutcome.Rejected(Rejection(RejectionKind.NotFound, "No link with that code.")))
        assertEquals(CheckoutState.NotFound("7hK2mQ9x"), checkout.state.value)
    }

    // ---- M3 review (c): a refused amount is never sent again ------------------------------

    @Test
    fun `after a price change whose re-read failed, Pay cannot re-submit the stale amount`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout, link(amountKobo = 1_500_000))
        checkout.pay(payer)
        runCurrent()
        gateway.initializes[0].complete(InitializeOutcome.Rejected(Rejection(RejectionKind.AmountMismatch, "mismatch")))
        runCurrent()
        gateway.lookups[1].complete(LookupOutcome.Failed(FailureKind.Network))
        runCurrent()
        val stale = checkout.state.value
        assertEquals(PayPhase.PriceChanged(null), (stale as CheckoutState.Loaded).pay)

        // The old amount is still what the loaded link holds, so a tap on Pay would send it again, and loop.
        checkout.pay(payer)
        checkout.pay(payer)
        runCurrent()

        assertEquals("the refused amount must not be sent again", 1, gateway.initializes.size)
        assertEquals(stale, checkout.state.value)
        assertTrue("the screen must be told it has no trustworthy price", stale.pay.needsFreshRead)
    }

    @Test
    fun `after a failed re-read, Pay is enabled again only by a successful fresh read`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout, link(amountKobo = 1_500_000))
        checkout.pay(payer)
        runCurrent()
        gateway.initializes[0].complete(InitializeOutcome.Rejected(Rejection(RejectionKind.AmountMismatch, "mismatch")))
        runCurrent()
        gateway.lookups[1].complete(LookupOutcome.Failed(FailureKind.Network))
        runCurrent()

        checkout.reload() // the screen's "Reload": a read that fails again changes nothing
        runCurrent()
        gateway.lookups[2].complete(LookupOutcome.Failed(FailureKind.Network))
        runCurrent()
        checkout.pay(payer)
        runCurrent()
        assertEquals(1, gateway.initializes.size)

        checkout.reload()
        runCurrent()
        gateway.lookups[3].complete(found(link(amountKobo = 1_800_000)))
        runCurrent()
        assertEquals(CheckoutState.Loaded(link(amountKobo = 1_800_000), LinkAvailability.Payable, PayPhase.Idle), checkout.state.value)

        checkout.pay(payer.copy(amountKobo = 1_800_000))
        runCurrent()
        assertEquals(2, gateway.initializes.size)
        assertEquals(1_800_000, gateway.initializes[1].request.first.amountKobo)
        // A different amount is a different request: it must not be sent under the refused one's key.
        assertTrue(gateway.initializes[0].request.second != gateway.initializes[1].request.second)
    }

    @Test
    fun `after a successful re-read the new price can be paid`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout, link(amountKobo = 1_500_000))
        checkout.pay(payer)
        runCurrent()
        gateway.initializes[0].complete(InitializeOutcome.Rejected(Rejection(RejectionKind.AmountMismatch, "mismatch")))
        runCurrent()
        gateway.lookups[1].complete(found(link(amountKobo = 1_800_000)))
        runCurrent()
        assertEquals(false, (checkout.state.value as CheckoutState.Loaded).pay.needsFreshRead)

        checkout.pay(payer.copy(amountKobo = 1_800_000))
        runCurrent()

        assertEquals(2, gateway.initializes.size)
        assertEquals(1_800_000, gateway.initializes[1].request.first.amountKobo)
    }

    @Test
    fun `no other phase asks for a fresh read`() {
        val request = InitializeRequest("7hK2mQ9x", 1_500_000, "Tunde Bello", "tunde@example.com")
        for (phase in listOf(
            PayPhase.Idle,
            PayPhase.Submitting,
            PayPhase.Started("kbl_abcdefghjk", 1_500_000),
            PayPhase.Rejected("no", emptyMap(), null),
            PayPhase.PriceChanged(1_800_000),
            PayPhase.Failed(FailureKind.Network, request),
        )) {
            assertEquals("$phase", false, phase.needsFreshRead)
        }
        assertEquals(true, PayPhase.PriceChanged(null).needsFreshRead)
    }

    // ---- M3 review (d): a started payment is shown again, and is never started twice ---------

    private suspend fun TestScope.started(
        gateway: FakeCheckoutGateway,
        checkout: CheckoutController,
        reference: String = "kbl_abcdefghjk",
    ) {
        loaded(gateway, checkout)
        payAndAnswer(gateway, checkout, InitializeOutcome.Started(reference, 1_500_000))
    }

    @Test
    fun `reopening the link while its payment is started shows the same reference`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        started(gateway, checkout)

        checkout.open("7hK2mQ9x") // the payer taps the link again
        runCurrent()
        assertEquals(CheckoutState.Loading("7hK2mQ9x"), checkout.state.value)
        gateway.lookups.last().complete(found())
        runCurrent()

        assertEquals(
            CheckoutState.Loaded(link(), LinkAvailability.Payable, PayPhase.Started("kbl_abcdefghjk", 1_500_000)),
            checkout.state.value,
        )
    }

    @Test
    fun `closing and reopening the link still shows the started payment`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        started(gateway, checkout)

        checkout.close() // "Done"
        loaded(gateway, checkout)

        assertEquals(PayPhase.Started("kbl_abcdefghjk", 1_500_000), (checkout.state.value as CheckoutState.Loaded).pay)
    }

    @Test
    fun `a Pay after reopening a started payment sends nothing, the started payment is the attempt`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        started(gateway, checkout)
        loaded(gateway, checkout) // reopened

        checkout.pay(payer)
        runCurrent()

        // A new key here would be a second pending checkout for the same payment; the only way out is Start a new payment.
        assertEquals(1, gateway.initializes.size)
        assertEquals(PayPhase.Started("kbl_abcdefghjk", 1_500_000), (checkout.state.value as CheckoutState.Loaded).pay)
    }

    @Test
    fun `a different link does not inherit a started payment, but the first link keeps its own`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        started(gateway, checkout)

        loaded(gateway, checkout, link(code = "Zz3Yy4Xx"))
        assertEquals(PayPhase.Idle, (checkout.state.value as CheckoutState.Loaded).pay)

        // Back on the first link its payment is still there (each link has its own slot, on disk): opening another
        // link used to drop an unsettled attempt, which is how a second pending checkout got made.
        loaded(gateway, checkout)
        assertEquals(PayPhase.Started("kbl_abcdefghjk", 1_500_000), (checkout.state.value as CheckoutState.Loaded).pay)
    }

    @Test
    fun `a started payment is not shown over a link that has since stopped being payable`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        started(gateway, checkout)

        loaded(gateway, checkout, availability = LinkAvailability.Disabled)

        assertEquals(CheckoutState.Loaded(link(), LinkAvailability.Disabled, PayPhase.Idle), checkout.state.value)
    }

    @Test
    fun `an unreadable link in between does not disturb a started payment`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        started(gateway, checkout)

        checkout.openUnreadable()
        assertEquals(CheckoutState.NotFound(code = null), checkout.state.value)
        loaded(gateway, checkout)

        assertEquals(PayPhase.Started("kbl_abcdefghjk", 1_500_000), (checkout.state.value as CheckoutState.Loaded).pay)
    }

    @Test
    fun `a re-read that finds the very amount that was refused does not unlock Pay`() = runTest {
        // The server said the amount does not match, yet the link still says the same amount: whatever is wrong is
        // not something sending it again can fix. "Price changed to the same price" and a live Pay button is a loop.
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout, link(amountKobo = 1_500_000))
        checkout.pay(payer)
        runCurrent()
        gateway.initializes[0].complete(InitializeOutcome.Rejected(Rejection(RejectionKind.AmountMismatch, "mismatch")))
        runCurrent()
        gateway.lookups[1].complete(found(link(amountKobo = 1_500_000)))
        runCurrent()

        assertTrue((checkout.state.value as CheckoutState.Loaded).pay.needsFreshRead)
        checkout.pay(payer)
        runCurrent()
        assertEquals("the refused amount is not sent again", 1, gateway.initializes.size)
    }

    @Test
    fun `a fixed-amount link that was repriced is not shown as started at the old price`() = runTest {
        // The payment was started for 15,000.00 and the link has since been repriced: the reference is still shown
        // (it exists, and is for that amount), never re-labelled with the new price.
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        started(gateway, checkout)

        loaded(gateway, checkout, link(amountKobo = 1_800_000))

        assertEquals(PayPhase.Started("kbl_abcdefghjk", 1_500_000), (checkout.state.value as CheckoutState.Loaded).pay)
    }

    @Test
    fun `a fixed link that became open-amount shows the amount field, not a price message`() = runTest {
        val gateway = FakeCheckoutGateway()
        val checkout = controller(gateway)
        loaded(gateway, checkout, link(amountKobo = 1_500_000))
        checkout.pay(payer)
        runCurrent()
        gateway.initializes[0].complete(InitializeOutcome.Rejected(Rejection(RejectionKind.AmountMismatch, "mismatch")))
        runCurrent()
        gateway.lookups[1].complete(found(link(amountKobo = null)))
        runCurrent()
        assertEquals(CheckoutState.Loaded(link(amountKobo = null), LinkAvailability.Payable, PayPhase.Idle), checkout.state.value)
    }
}
