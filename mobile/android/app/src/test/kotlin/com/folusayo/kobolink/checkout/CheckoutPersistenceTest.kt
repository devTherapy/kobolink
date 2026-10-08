package com.folusayo.kobolink.checkout

import com.folusayo.kobolink.auth.AuthenticatedUser
import com.folusayo.kobolink.auth.SessionChange
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
        owner: AttemptOwner,
    ) {
        private val background = testScope.backgroundScope.coroutineContext
        private val scope = CoroutineScope(background + Job(background[Job]))
        private var next = 0
        val checkout = CheckoutController(
            gateway,
            scope,
            store,
            newIdempotencyKey = { "run$run-key-${next++}-0123456789" },
            ownerNow = { owner },
        )

        fun finish() = scope.cancel()
    }

    private fun TestScope.appRun(
        gateway: FakeCheckoutGateway,
        store: PendingCheckoutStore,
        run: Int,
        owner: AttemptOwner = AttemptOwner.Payer,
    ) = AppRun(this, gateway, store, run, owner)

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
    fun `a Pay after that re-tap makes no second checkout, the started payment is the attempt`() = runTest {
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

        assertEquals(1, gateway.initializes.size)
        assertEquals("run1-key-0-0123456789", store.load(code)?.key)
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
        second.checkout.retry()
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
        second.checkout.retry()
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
        second.checkout.retry()
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
        assertEquals(PendingCheckout(request, key = "run1-key-0-0123456789"), store.load(code))
    }

    @Test
    fun `a payment that cannot be recorded is not sent, and says no money was taken`() = runTest {
        val gateway = FakeCheckoutGateway()
        val store = InMemoryPendingCheckoutStore()
        val app = appRun(gateway, store, run = 1)
        open(app)
        store.fail(StoreOperation.Write) // reads work (nothing is remembered), writes do not

        app.checkout.pay(payer)
        runCurrent()

        assertTrue("nothing may be sent that was not first recorded", gateway.initializes.isEmpty())
        assertEquals(PayPhase.NotRecorded(request), payOf(app))
        assertTrue(PAY_NOT_RECORDED_MESSAGE.contains("No money was taken"))
    }

    @Test
    fun `a write that fails is the same, not sent, however many times the payer taps`() = runTest {
        val gateway = FakeCheckoutGateway()
        val store = object : PendingCheckoutStore by InMemoryPendingCheckoutStore() {
            override fun save(pending: PendingCheckout) {
                throw PendingStoreException(StoreOperation.Write)
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
    fun `secure storage that cannot be opened blocks the link, instead of reading as nothing remembered`() = runTest {
        val gateway = FakeCheckoutGateway()
        val app = appRun(gateway, UnavailablePendingCheckoutStore(IllegalStateException("keystore")), run = 1)

        app.checkout.open(code)
        runCurrent()

        assertEquals(CheckoutState.StorageBlocked(code, StorageBlock.Unreadable),app.checkout.state.value)
        assertTrue(gateway.lookups.isEmpty() && gateway.initializes.isEmpty())
    }

    @Test
    fun `the reference is written once the server answers`() = runTest {
        val store = InMemoryPendingCheckoutStore()
        val app = appRun(FakeCheckoutGateway(), store, run = 1)
        open(app)
        payAndAnswer(app, InitializeOutcome.Started(reference, 1_500_000))

        assertEquals(
            PendingCheckout(request, "run1-key-0-0123456789", reference, confirmedAmountKobo = 1_500_000),
            store.load(code),
        )
    }

    @Test
    fun `a definite refusal clears the slot, so the next tap is a clean start`() = runTest {
        val gateway = FakeCheckoutGateway()
        val store = InMemoryPendingCheckoutStore()
        val first = appRun(gateway, store, run = 1)
        open(first)
        payAndAnswer(first, InitializeOutcome.Rejected(refusal(RejectionKind.LinkNotPayable, "no", availability = LinkAvailability.Disabled)))
        assertNull(store.load(code))
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
            assertNotNull("$kind is an unknown outcome", store.load(code))
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
        first.checkout.retry()
        runCurrent()

        assertTrue(keys(gateway)[0] != keys(gateway)[1])
        assertEquals("the other link's retry reuses ITS key", keys(gateway)[1], keys(gateway)[2])
    }

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
        assertNull(store.load(code))
        app.checkout.pay(payer)
        runCurrent()
        assertTrue("a deliberate new payment has a new key", keys(gateway)[0] != keys(gateway)[1])
    }

    @Test
    fun `starting over that the disk refuses changes nothing and says so, then works once the disk lets go`() = runTest {
        val gateway = FakeCheckoutGateway()
        val inner = InMemoryPendingCheckoutStore()
        val store: PendingCheckoutStore = inner
        // The payment itself must be recordable, so make it first while the disk works, then break clearing.
        val app = appRun(gateway, store, run = 1)
        open(app)
        payAndAnswer(app, InitializeOutcome.Started(reference, 1_500_000))
        inner.fail(StoreOperation.Remove)

        app.checkout.startOver()
        runCurrent()

        assertEquals("no silent no-op: the screen is told", PayPhase.Started(reference, 1_500_000, startOverFailed = true), payOf(app))
        assertEquals("and no lookup was started, so nothing was forgotten in memory only", 1, gateway.lookups.size)
        inner.heal()
        assertNotNull(inner.load(code))

        app.checkout.startOver()
        runCurrent()
        gateway.lookups.last().complete(found())
        runCurrent()

        assertEquals(PayPhase.Idle, payOf(app))
        assertNull(inner.load(code))
    }

    @Test
    fun `starting over clears the slot whoever made it`() = runTest {
        val gateway = FakeCheckoutGateway()
        val store = InMemoryPendingCheckoutStore()
        val first = appRun(gateway, store, run = 1, owner = AttemptOwner.Session("u1"))
        open(first)
        payAndAnswer(first, InitializeOutcome.Started(reference, 1_500_000))
        first.finish()

        val second = appRun(gateway, store, run = 2)
        open(second) // resolving: shown from the single slot
        second.checkout.startOver()
        runCurrent()
        gateway.lookups.last().complete(found())
        runCurrent()
        // and the user arriving afterwards cannot bring it back
        second.checkout.sessionDidChange(SessionChange.Resolved(AuthenticatedUser("u1", "u1@example.test", "One")))

        assertNull(store.load(code))
        assertEquals(PayPhase.Idle, payOf(second))
    }

    @Test
    fun `starting over a remembered attempt opens an EMPTY form and a new key`() = runTest {
        val gateway = FakeCheckoutGateway()
        val store = InMemoryPendingCheckoutStore()
        val first = appRun(gateway, store, run = 1)
        open(first)
        payAndAnswer(first, InitializeOutcome.Failed(FailureKind.Network))
        first.finish()

        val second = appRun(gateway, store, run = 2)
        open(second)
        assertEquals(PayPhase.Failed(FailureKind.Interrupted, request), payOf(second))
        second.checkout.startOver()
        runCurrent()
        gateway.lookups.last().complete(found())
        runCurrent()

        assertEquals(PayPhase.Idle, payOf(second))
        assertNull(store.load(code))
        second.checkout.pay(payer)
        runCurrent()
        assertTrue("a deliberate new payment has a new key", keys(gateway).first() != keys(gateway).last())
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
    fun `an unknown attempt is still the attempt after the price changed, and cannot be replaced by paying the new price`() = runTest {
        val gateway = FakeCheckoutGateway()
        val store = InMemoryPendingCheckoutStore()
        val first = appRun(gateway, store, run = 1)
        open(first)
        payAndAnswer(first, InitializeOutcome.Failed(FailureKind.Network))
        first.finish()

        val second = appRun(gateway, store, run = 2)
        open(second, link = link(amountKobo = 1_800_000)) // repriced meanwhile; a fresh read says so
        assertEquals(PayPhase.Failed(FailureKind.Interrupted, request), payOf(second))
        second.checkout.pay(payer.copy(amountKobo = 1_800_000)) // there is no form to do this from; if it got here it is ignored
        runCurrent()

        assertEquals("nothing but the first send", 1, gateway.initializes.size)
        assertEquals("run1-key-0-0123456789", store.load(code)?.key)
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
    fun `an unreadable store slot is neither nothing nor usable, it blocks the link until the payer starts over`() = runTest {
        val disk = FakePrefs()
        disk.disk["pending/$code"] = "not json"
        val gateway = FakeCheckoutGateway()
        val app = appRun(gateway, EncryptedPendingCheckoutStore(disk), run = 1)

        app.checkout.open(code)
        runCurrent()

        assertEquals(CheckoutState.StorageBlocked(code, StorageBlock.Undecodable), app.checkout.state.value)
        assertTrue(gateway.lookups.isEmpty())

        app.checkout.startOver()
        runCurrent()
        gateway.lookups.last().complete(found())
        runCurrent()
        assertEquals(PayPhase.Idle, payOf(app))
        assertTrue(disk.disk.isEmpty())
    }
}
