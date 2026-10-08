package com.folusayo.kobolink

import com.folusayo.kobolink.auth.AuthRepository
import com.folusayo.kobolink.auth.FakeAuthApi
import com.folusayo.kobolink.auth.RecordingTokenStore
import com.folusayo.kobolink.auth.SessionController
import com.folusayo.kobolink.auth.SessionState
import com.folusayo.kobolink.auth.authResponseUser
import com.folusayo.kobolink.auth.loginSuccess
import com.folusayo.kobolink.auth.meSuccess
import com.folusayo.kobolink.checkout.AttemptOwner
import com.folusayo.kobolink.checkout.CheckoutState
import com.folusayo.kobolink.checkout.FailureKind
import com.folusayo.kobolink.checkout.FakeCheckoutGateway
import com.folusayo.kobolink.checkout.InMemoryPendingCheckoutStore
import com.folusayo.kobolink.checkout.InitializeOutcome
import com.folusayo.kobolink.checkout.PayPhase
import com.folusayo.kobolink.checkout.StoreOperation
import com.folusayo.kobolink.checkout.found
import com.folusayo.kobolink.checkout.payer
import com.folusayo.kobolink.generated.api.infrastructure.Serializer
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import retrofit2.Response

/**
 * The ViewModel level of M3's two recorded defects, with the real [SessionController] and [CheckoutController] wired
 * the way the app wires them (the hooks, the owner, the form). These tests were written FIRST against the code at
 * 7d67abb and failed there (`RedFirstM3FreshTest`, kept in the branch history):
 *
 * (A) sign-out and a user change left the payer's name, e-mail and amount in the form;
 * (B) an attempt made while the session was resolving or offline was never removed by sign-out.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MainViewModelTest {
    private val code = "7hK2mQ9x"

    @Before
    fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())

    @After
    fun tearDown() = Dispatchers.resetMain()

    private class Harness(
        val vm: MainViewModel,
        val api: FakeAuthApi,
        val tokens: RecordingTokenStore,
        val gateway: FakeCheckoutGateway,
        val store: InMemoryPendingCheckoutStore,
        val expiry: MutableSharedFlow<Unit>,
    )

    /** A phone with [token] stored; the cold-start check runs in the ViewModel's init. */
    private fun harness(token: String? = "valid-token", offline: Boolean = false): Harness {
        val tokens = RecordingTokenStore().also { if (token != null) it.saveToken(token) }
        val someoneElse = Response.success(loginSuccess().body()!!.copy(user = authResponseUser.copy(id = "user_456")))
        val api = FakeAuthApi(
            loginResponse = someoneElse,
            meResponse = if (offline) null else meSuccess(),
            meThrows = if (offline) IOException("airplane mode") else null,
        )
        val session = SessionController(AuthRepository(api, tokens, Serializer.kotlinxSerializationJson))
        val gateway = FakeCheckoutGateway()
        val store = InMemoryPendingCheckoutStore()
        val expiry = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        return Harness(MainViewModel(session, expiry, gateway, store), api, tokens, gateway, store, expiry)
    }

    private fun Harness.typeSomething() {
        vm.checkoutForm.amountText = "5000"
        vm.checkoutForm.name = "Tunde Bello"
        vm.checkoutForm.email = "tunde@example.com"
    }

    private fun Harness.assertFormEmpty() {
        assertEquals("", vm.checkoutForm.name)
        assertEquals("", vm.checkoutForm.email)
        assertEquals("", vm.checkoutForm.amountText)
        assertTrue(vm.checkoutForm.errors.isEmpty())
    }

    /** Open [code], answer its lookup, type the payer's details, pay, and let the outcome stay unknown. */
    private fun Harness.attempt() {
        vm.openLink(code)
        gateway.lookups.last().complete(found())
        typeSomething()
        vm.checkout.pay(payer)
        gateway.initializes.last().complete(InitializeOutcome.Failed(FailureKind.Network))
    }

    // ---- (A) the form -----------------------------------------------------------------------------------------

    @Test
    fun `A - after an explicit sign-out the next person who opens the same link finds an empty form`() = runTest {
        val h = harness()
        h.vm.openLink(code) // the merchant is confirmed signed in (the cold-start check ran in init)
        h.typeSomething()
        h.vm.closeLink() // Back

        h.vm.logout()
        h.vm.openLink(code) // the next person taps the same link

        h.assertFormEmpty()
    }

    @Test
    fun `A - sign-out empties the form of a link that is still open, synchronously`() = runTest {
        val h = harness()
        h.vm.openLink(code)
        h.typeSomething()

        h.vm.logout()

        h.assertFormEmpty() // before any lookup has been answered
        assertTrue(h.vm.sessionState.value is SessionState.SignedOut)
    }

    @Test
    fun `A - a confirmed different user finds an empty form`() = runTest {
        val h = harness()
        h.vm.openLink(code)
        h.typeSomething()
        h.vm.closeLink()
        h.expiry.tryEmit(Unit) // the first user's session ends (a 401)
        h.vm.login("someone@example.com", "pw") // somebody else signs in on the same phone

        h.vm.openLink(code)

        h.assertFormEmpty()
    }

    @Test
    fun `an involuntary end of session clears neither the form nor the attempt`() = runTest {
        val h = harness()
        h.attempt()

        h.expiry.tryEmit(Unit)

        assertEquals("Tunde Bello", h.vm.checkoutForm.name)
        assertEquals(1, h.store.snapshot.size)
        assertTrue(h.vm.sessionState.value is SessionState.SignedOut)
    }

    // ---- (B) who owns an attempt -------------------------------------------------------------------------------

    @Test
    fun `B - an attempt made while the session could not be confirmed is removed by the sign-out of the user it turns out to be`() = runTest {
        val h = harness(offline = true)
        h.attempt() // the session is offline: the attempt belongs to a session, to nobody in particular yet
        assertEquals(AttemptOwner.Session(null), h.store.snapshot.single().owner)

        h.api.meThrows = null
        h.api.meResponse = meSuccess()
        h.vm.retry() // /me confirms the merchant
        assertEquals(AttemptOwner.Session("user_123"), h.store.snapshot.single().owner)

        h.vm.logout()

        assertTrue("the signing-out user's attempt must not survive for the next person", h.store.snapshot.isEmpty())
        assertNull(h.tokens.token())
    }

    @Test
    fun `B - a payer's attempt survives a merchant signing in and out on the same phone`() = runTest {
        val h = harness(token = null)
        h.attempt()
        assertEquals(AttemptOwner.Payer, h.store.snapshot.single().owner)

        h.vm.login("someone@example.com", "pw")
        h.vm.logout()

        assertEquals(1, h.store.snapshot.size)
        assertEquals(AttemptOwner.Payer, h.store.snapshot.single().owner)
    }

    // ---- the sign-out gate -----------------------------------------------------------------------------------------

    @Test
    fun `a sign-out that cannot be made safe does not happen, the token is kept and the person is told`() = runTest {
        val h = harness()
        h.attempt()
        h.store.fail(StoreOperation.Obligation) // what the sign-out owes cannot be written down

        h.vm.logout()

        assertTrue(h.vm.sessionState.value is SessionState.SignedIn)
        assertEquals("valid-token", h.tokens.token())
        assertEquals("nothing was revoked", 0, h.tokens.clearCalls)
        assertFalse(h.api.logoutCalled)
        assertTrue(h.vm.signOutBlocked.value)
        assertEquals("Tunde Bello", h.vm.checkoutForm.name)
        assertEquals(1, h.store.snapshot.size)

        // Storage recovers: the person tries again, and this time it goes through.
        h.store.heal()
        h.vm.acknowledgeSignOutBlocked()
        assertFalse(h.vm.signOutBlocked.value)
        h.vm.logout()

        assertTrue(h.vm.sessionState.value is SessionState.SignedOut)
        assertNull(h.tokens.token())
        assertTrue(h.store.snapshot.isEmpty())
        h.assertFormEmpty()
    }

    @Test
    fun `the checkout shown after a sign-out is a fresh lookup, not the previous person's screen`() = runTest {
        val h = harness()
        h.attempt()

        h.vm.logout()

        assertTrue(h.vm.checkout.state.value is CheckoutState.Loading)
        h.gateway.lookups.last().complete(found())
        assertEquals(PayPhase.Idle, (h.vm.checkout.state.value as CheckoutState.Loaded).pay)
    }
}
