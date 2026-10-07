package com.folusayo.kobolink.checkout

import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M3 review round 2, item (d) on the payer's path. The idempotency key and the started reference used to live only
 * in the controller, which lives in the Activity's ViewModel. A payer's Done and Back both `finish()` the Activity,
 * so the next tap on the link built a new controller with a new key: a second pending checkout for one payment.
 * Process death, and Back while a request is in flight, lost it the same way.
 *
 * Here "the app closed" is a new [CheckoutController] over the SAME store, with its own key sequence (so a reused
 * key is a real reuse and not two counters that happen to agree).
 */
class CheckoutPersistenceTest {

    private val code = "7hK2mQ9x"
    private val other = "Zz3Yy4Xx"
    private val reference = "kbl_abcdefghjk"
    private val request = InitializeRequest(code, 1_500_000, "Tunde Bello", "tunde@example.com")

    /** One run of the app: a controller in a scope that `finish()` cancels, as clearing a ViewModel does. */
    private inner class AppRun(
        testScope: TestScope,
        val gateway: FakeCheckoutGateway,
        store: PendingCheckoutStore,
        run: Int,
    ) {
        private val background = testScope.backgroundScope.coroutineContext
        private val scope = CoroutineScope(background + Job(background[Job]))
        private var next = 0
        val checkout = CheckoutController(gateway, scope, store, newIdempotencyKey = { "run$run-key-${next++}-0123456789" })

        fun finish() = scope.cancel()
    }

    private fun TestScope.appRun(gateway: FakeCheckoutGateway, store: PendingCheckoutStore, run: Int) =
        AppRun(this, gateway, store, run)

    private suspend fun TestScope.open(app: AppRun, code: String = this@CheckoutPersistenceTest.code, link: CheckoutLink = link(code = code)) {
        app.checkout.open(code)
        runCurrent()
        app.gateway.lookups.last().complete(found(link))
        runCurrent()
    }

    private suspend fun TestScope.payAndAnswer(app: AppRun, outcome: InitializeOutcome) {
        app.checkout.pay(payer)
        runCurrent()
        app.gateway.initializes.last().complete(outcome)
        runCurrent()
    }

    private fun payOf(app: AppRun) = (app.checkout.state.value as CheckoutState.Loaded).pay

    private fun keys(gateway: FakeCheckoutGateway) = gateway.initializes.map { it.request.second }

    // ---- Done / Back, then a re-tap -----------------------------------------------------------

    @Test
    fun `a payer's Done finishes the app, and re-tapping the link shows the same started payment`() = runTest {
        val gateway = FakeCheckoutGateway()
        val store = InMemoryPendingCheckoutStore()
        val first = appRun(gateway, store, run = 1)
        open(first)
        payAndAnswer(first, InitializeOutcome.Started(reference, 1_500_000))
        first.finish() // Done -> backFromLink(SignedOut) -> LeaveApp -> finish() -> the ViewModel is gone

        val second = appRun(gateway, store, run = 2)
        open(second) // the payer taps the link in WhatsApp again

        assertEquals(PayPhase.Started(reference, 1_500_000), payOf(second))
    }

    @Test
    fun `a Pay after that re-tap replays the first attempt's key instead of making a second checkout`() = runTest {
        val gateway = FakeCheckoutGateway()
        val store = InMemoryPendingCheckoutStore()
        val first = appRun(gateway, store, run = 1)
        open(first)
        payAndAnswer(first, InitializeOutcome.Started(reference, 1_500_000))
        first.finish()

        val second = appRun(gateway, store, run = 2)
        open(second)
        second.checkout.pay(payer)
        runCurrent()

        assertEquals(2, gateway.initializes.size)
        assertEquals("run1-key-0-0123456789", keys(gateway)[1])
    }

    @Test
    fun `Back after a failed request, then a re-tap, retries the same request under the same key`() = runTest {
        val gateway = FakeCheckoutGateway()
        val store = InMemoryPendingCheckoutStore()
        val first = appRun(gateway, store, run = 1)
        open(first)
        payAndAnswer(first, InitializeOutcome.Failed(FailureKind.Network)) // the POST may have landed
        first.finish()

        val second = appRun(gateway, store, run = 2)
        open(second)
        // The screen says so, and carries the exact request so the form can be filled back in.
        assertEquals(PayPhase.Failed(FailureKind.Interrupted, request), payOf(second))
        second.checkout.pay(payer)
        runCurrent()

        assertEquals(listOf("run1-key-0-0123456789", "run1-key-0-0123456789"), keys(gateway))
    }

    @Test
    fun `Back while the request is in flight, then a re-tap, retries under the same key`() = runTest {
        val gateway = FakeCheckoutGateway()
        val store = InMemoryPendingCheckoutStore()
        val first = appRun(gateway, store, run = 1)
        open(first)
        first.checkout.pay(payer)
        runCurrent() // in flight: the answer never arrives
        first.finish() // viewModelScope is cancelled with the Activity

        val second = appRun(gateway, store, run = 2)
        open(second)
        assertEquals(PayPhase.Failed(FailureKind.Interrupted, request), payOf(second))
        second.checkout.pay(payer)
        runCurrent()

        assertEquals(listOf("run1-key-0-0123456789", "run1-key-0-0123456789"), keys(gateway))
    }

    @Test
    fun `after process death a new process over the same disk finds the started payment`() = runTest {
        val disk = FakePrefs()
        val gateway = FakeCheckoutGateway()
        val first = appRun(gateway, EncryptedPendingCheckoutStore(disk), run = 1)
        open(first)
        payAndAnswer(first, InitializeOutcome.Started(reference, 1_500_000))
        first.finish()

        val second = appRun(gateway, EncryptedPendingCheckoutStore(disk), run = 2) // nothing but the disk survived
        open(second)

        assertEquals(PayPhase.Started(reference, 1_500_000), payOf(second))
    }

    @Test
    fun `after process death mid-request the disk holds the key, so the retry carries it`() = runTest {
        val disk = FakePrefs()
        val gateway = FakeCheckoutGateway()
        val first = appRun(gateway, EncryptedPendingCheckoutStore(disk), run = 1)
        open(first)
        first.checkout.pay(payer)
        runCurrent()
        first.finish()

        val second = appRun(gateway, EncryptedPendingCheckoutStore(disk), run = 2)
        open(second)
        second.checkout.pay(payer)
        runCurrent()

        assertEquals(listOf("run1-key-0-0123456789", "run1-key-0-0123456789"), keys(gateway))
    }

    // ---- what is written, and when ------------------------------------------------------------

    @Test
    fun `the attempt is on disk before the request leaves`() = runTest {
        val gateway = FakeCheckoutGateway()
        val store = InMemoryPendingCheckoutStore()
        val app = appRun(gateway, store, run = 1)
        open(app)

        app.checkout.pay(payer)
        runCurrent()

        assertEquals("the request is in flight", 1, gateway.initializes.size)
        assertEquals(PendingCheckout(request, key = "run1-key-0-0123456789"), store.load(PAYER_OWNER, code))
    }

    @Test
    fun `a payment that cannot be recorded is not sent, and says no money was taken`() = runTest {
        val gateway = FakeCheckoutGateway()
        val app = appRun(gateway, UnavailablePendingCheckoutStore(IllegalStateException("keystore")), run = 1)
        open(app)

        app.checkout.pay(payer)
        runCurrent()

        assertTrue("nothing may be sent that was not first recorded", gateway.initializes.isEmpty())
        assertEquals(PayPhase.NotRecorded(request), payOf(app))
        assertTrue(PAY_NOT_RECORDED_MESSAGE.contains("No money was taken"))
    }

    @Test
    fun `a write that fails is the same, not sent`() = runTest {
        val gateway = FakeCheckoutGateway()
        val store = object : PendingCheckoutStore by InMemoryPendingCheckoutStore() {
            override fun save(owner: String, code: String, pending: PendingCheckout?) {
                throw IOException("disk full")
            }
        }
        val app = appRun(gateway, store, run = 1)
        open(app)

        app.checkout.pay(payer)
        app.checkout.pay(payer)
        runCurrent()

        assertTrue(gateway.initializes.isEmpty())
        assertEquals(PayPhase.NotRecorded(request), payOf(app))
    }

    @Test
    fun `the reference is written once the server answers`() = runTest {
        val store = InMemoryPendingCheckoutStore()
        val app = appRun(FakeCheckoutGateway(), store, run = 1)
        open(app)
        payAndAnswer(app, InitializeOutcome.Started(reference, 1_500_000))

        assertEquals(
            PendingCheckout(request, "run1-key-0-0123456789", reference, confirmedAmountKobo = 1_500_000),
            store.load(PAYER_OWNER, code),
        )
    }

    @Test
    fun `a definite refusal clears the slot, so the next tap is a clean start`() = runTest {
        val gateway = FakeCheckoutGateway()
        val store = InMemoryPendingCheckoutStore()
        val first = appRun(gateway, store, run = 1)
        open(first)
        payAndAnswer(first, InitializeOutcome.Rejected(Rejection(RejectionKind.LinkNotPayable, "no", availability = LinkAvailability.Disabled)))
        assertNull(store.load(PAYER_OWNER, code))
        first.finish()

        val second = appRun(gateway, store, run = 2)
        open(second)
        assertEquals(PayPhase.Idle, payOf(second))
    }

    @Test
    fun `a failure that is not a refusal keeps the slot`() = runTest {
        val store = InMemoryPendingCheckoutStore()
        val app = appRun(FakeCheckoutGateway(), store, run = 1)
        open(app)
        for (kind in listOf(FailureKind.Network, FailureKind.Server, FailureKind.RateLimited, FailureKind.Unreadable)) {
            payAndAnswer(app, InitializeOutcome.Failed(kind))
            assertNotNull("$kind is an unknown outcome", store.load(PAYER_OWNER, code))
        }
    }

    // ---- one slot per link, per owner -------------------------------------------------------

    @Test
    fun `each link keeps its own slot`() = runTest {
        val gateway = FakeCheckoutGateway()
        val store = InMemoryPendingCheckoutStore()
        val first = appRun(gateway, store, run = 1)
        open(first)
        payAndAnswer(first, InitializeOutcome.Started(reference, 1_500_000))
        open(first, code = other) // a different link is tapped
        assertEquals(PayPhase.Idle, payOf(first))
        payAndAnswer(first, InitializeOutcome.Failed(FailureKind.Network))

        open(first) // back to the first: its payment is still there
        assertEquals(PayPhase.Started(reference, 1_500_000), payOf(first))
        open(first, code = other) // and the second one's unknown attempt is too
        assertEquals(PayPhase.Failed(FailureKind.Interrupted, request.copy(code = other)), payOf(first))
        first.checkout.pay(payer)
        runCurrent()

        assertTrue(keys(gateway)[0] != keys(gateway)[1])
        assertEquals("the other link's retry reuses ITS key", keys(gateway)[1], keys(gateway)[2])
    }

    @Test
    fun `signing out clears that user's pending payments, in memory and on disk`() = runTest {
        val gateway = FakeCheckoutGateway()
        val store = InMemoryPendingCheckoutStore()
        val app = appRun(gateway, store, run = 1)
        app.checkout.bindOwner("u1")
        open(app)
        payAndAnswer(app, InitializeOutcome.Started(reference, 1_500_000))
        assertNotNull(store.load(ownerFor("u1"), code))

        app.checkout.bindOwner(null) // sign-out

        assertNull(store.load(ownerFor("u1"), code))
        assertEquals("the previous user's reference is not left on screen", CheckoutState.Idle, app.checkout.state.value)
        open(app)
        assertEquals(PayPhase.Idle, payOf(app))
    }

    @Test
    fun `switching to another user clears the first one's too`() = runTest {
        val store = InMemoryPendingCheckoutStore()
        val app = appRun(FakeCheckoutGateway(), store, run = 1)
        app.checkout.bindOwner("u1")
        open(app)
        payAndAnswer(app, InitializeOutcome.Started(reference, 1_500_000))

        app.checkout.bindOwner("u2")

        assertNull(store.load(ownerFor("u1"), code))
        open(app)
        assertEquals(PayPhase.Idle, payOf(app))
    }

    @Test
    fun `a payer's payment is neither shown to a signed-in user nor cleared by their sign-out`() = runTest {
        val gateway = FakeCheckoutGateway()
        val store = InMemoryPendingCheckoutStore()
        val payerRun = appRun(gateway, store, run = 1)
        open(payerRun)
        payAndAnswer(payerRun, InitializeOutcome.Started(reference, 1_500_000))
        payerRun.finish()

        val merchantRun = appRun(gateway, store, run = 2)
        merchantRun.checkout.bindOwner("u1")
        open(merchantRun)
        assertEquals("a signed-in user does not see a payer's reference", PayPhase.Idle, payOf(merchantRun))
        merchantRun.checkout.bindOwner(null)

        assertNotNull(store.load(PAYER_OWNER, code))
    }

    @Test
    fun `becoming signed in after the checkout opened does not disturb it`() = runTest {
        // Cold start with a stored token: the link opens while the session is still resolving (no user yet).
        val app = appRun(FakeCheckoutGateway(), InMemoryPendingCheckoutStore(), run = 1)
        open(app)
        payAndAnswer(app, InitializeOutcome.Started(reference, 1_500_000))

        app.checkout.bindOwner("u1")

        assertEquals(PayPhase.Started(reference, 1_500_000), payOf(app))
    }

    // ---- leaving a payment on purpose ---------------------------------------------------------

    @Test
    fun `starting a new payment forgets the old one and looks the link up again`() = runTest {
        val gateway = FakeCheckoutGateway()
        val store = InMemoryPendingCheckoutStore()
        val app = appRun(gateway, store, run = 1)
        open(app)
        payAndAnswer(app, InitializeOutcome.Started(reference, 1_500_000))

        app.checkout.startOver()
        runCurrent()
        assertEquals(CheckoutState.Loading(code), app.checkout.state.value)
        gateway.lookups.last().complete(found())
        runCurrent()

        assertEquals(PayPhase.Idle, payOf(app))
        assertNull(store.load(PAYER_OWNER, code))
        app.checkout.pay(payer)
        runCurrent()
        assertTrue("a deliberate new payment has a new key", keys(gateway)[0] != keys(gateway)[1])
    }

    @Test
    fun `starting over reaches the disk, so a restart does not bring the old payment back`() = runTest {
        val disk = FakePrefs()
        val gateway = FakeCheckoutGateway()
        val first = appRun(gateway, EncryptedPendingCheckoutStore(disk), run = 1)
        open(first)
        payAndAnswer(first, InitializeOutcome.Started(reference, 1_500_000))
        first.checkout.startOver()
        first.finish()

        val second = appRun(gateway, EncryptedPendingCheckoutStore(disk), run = 2)
        open(second)

        assertEquals(PayPhase.Idle, payOf(second))
    }

    @Test
    fun `starting over with nothing open does nothing`() = runTest {
        val gateway = FakeCheckoutGateway()
        val app = appRun(gateway, InMemoryPendingCheckoutStore(), run = 1)
        app.checkout.startOver()
        runCurrent()
        assertTrue(gateway.lookups.isEmpty())
    }

    // ---- an attempt that no longer matches the link -----------------------------------------

    @Test
    fun `an unknown attempt at an old price is not offered as a retry once the price has changed`() = runTest {
        val gateway = FakeCheckoutGateway()
        val store = InMemoryPendingCheckoutStore()
        val first = appRun(gateway, store, run = 1)
        open(first)
        payAndAnswer(first, InitializeOutcome.Failed(FailureKind.Network))
        first.finish()

        val second = appRun(gateway, store, run = 2)
        open(second, link = link(amountKobo = 1_800_000)) // repriced meanwhile; a fresh read says so
        assertEquals(PayPhase.Idle, payOf(second))
        second.checkout.pay(payer.copy(amountKobo = 1_800_000))
        runCurrent()

        assertTrue("a changed amount is a new request: new key", keys(gateway)[0] != keys(gateway)[1])
    }

    @Test
    fun `an unknown attempt is not shown over a link that stopped being payable`() = runTest {
        val gateway = FakeCheckoutGateway()
        val store = InMemoryPendingCheckoutStore()
        val first = appRun(gateway, store, run = 1)
        open(first)
        payAndAnswer(first, InitializeOutcome.Failed(FailureKind.Network))
        first.finish()

        val second = appRun(gateway, store, run = 2)
        second.checkout.open(code)
        runCurrent()
        gateway.lookups.last().complete(found(availability = LinkAvailability.Disabled))
        runCurrent()

        assertEquals(CheckoutState.Loaded(link(), LinkAvailability.Disabled, PayPhase.Idle), second.checkout.state.value)
    }

    @Test
    fun `an unreadable store slot is no slot`() = runTest {
        val disk = FakePrefs()
        disk.disk["pending/payer/$code"] = "not json"
        val app = appRun(FakeCheckoutGateway(), EncryptedPendingCheckoutStore(disk), run = 1)
        open(app)
        assertEquals(PayPhase.Idle, payOf(app))
    }
}
