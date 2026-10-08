package com.folusayo.kobolink

import com.folusayo.kobolink.auth.AuthRepository
import com.folusayo.kobolink.auth.FakeAuthApi
import com.folusayo.kobolink.auth.RecordingTokenStore
import com.folusayo.kobolink.auth.authResponseUser
import com.folusayo.kobolink.auth.SessionController
import com.folusayo.kobolink.auth.loginSuccess
import com.folusayo.kobolink.auth.meSuccess
import com.folusayo.kobolink.checkout.CheckoutController
import com.folusayo.kobolink.checkout.FailureKind
import com.folusayo.kobolink.checkout.FakeCheckoutGateway
import com.folusayo.kobolink.checkout.InMemoryPendingCheckoutStore
import com.folusayo.kobolink.checkout.InitializeOutcome
import com.folusayo.kobolink.checkout.found
import com.folusayo.kobolink.checkout.payer
import com.folusayo.kobolink.generated.api.infrastructure.Serializer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import retrofit2.Response

/**
 * RED FIRST for the two defects the M3 reviewers recorded (round 4). Written against the code as it stood at 7d67abb
 * and meant to FAIL there:
 *
 * (A) sign-out and a user change leave the payer's name, e-mail and amount in the checkout form;
 * (B) an attempt saved while the session was still resolving has no owner, so sign-out never removes it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RedFirstM3FreshTest {
    private val code = "7hK2mQ9x"

    @Before
    fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun viewModel(gateway: FakeCheckoutGateway, expiry: MutableSharedFlow<Unit> = MutableSharedFlow()): MainViewModel {
        val tokens = RecordingTokenStore().also { it.saveToken("valid-token") }
        val someoneElse = Response.success(loginSuccess().body()!!.copy(user = authResponseUser.copy(id = "user_456")))
        val api = FakeAuthApi(loginResponse = someoneElse, meResponse = meSuccess())
        val session = SessionController(AuthRepository(api, tokens, Serializer.kotlinxSerializationJson))
        return MainViewModel(session, expiry, gateway, InMemoryPendingCheckoutStore())
    }

    private fun MainViewModel.typeSomething() {
        checkoutForm.amountText = "5000"
        checkoutForm.name = "Tunde Bello"
        checkoutForm.email = "tunde@example.com"
    }

    @Test
    fun `A - after an explicit sign-out the next person who opens the same link finds an empty form`() = runTest {
        val vm = viewModel(FakeCheckoutGateway())
        vm.openLink(code) // the merchant is confirmed signed in (the cold-start check ran in init)
        vm.typeSomething()
        vm.closeLink() // Back

        vm.logout()
        vm.openLink(code) // the next person taps the same link

        assertEquals("", vm.checkoutForm.name)
        assertEquals("", vm.checkoutForm.email)
        assertEquals("", vm.checkoutForm.amountText)
    }

    @Test
    fun `A - a confirmed different user finds an empty form`() = runTest {
        val expiry = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        val vm = viewModel(FakeCheckoutGateway(), expiry)
        vm.openLink(code)
        vm.typeSomething()
        vm.closeLink()
        expiry.tryEmit(Unit) // the first user's session ends (a 401)
        vm.login("someone@example.com", "pw") // somebody signs in on the same phone
        vm.openLink(code)

        assertEquals("", vm.checkoutForm.name)
        assertEquals("", vm.checkoutForm.email)
        assertEquals("", vm.checkoutForm.amountText)
    }

    @Test
    fun `B - an attempt made while the session was resolving is removed by the sign-out of the user it turns out to be`() = runTest {
        val gateway = FakeCheckoutGateway()
        val store = InMemoryPendingCheckoutStore()
        var n = 0
        val checkout = CheckoutController(gateway, backgroundScope, store, newIdempotencyKey = { "key-${n++}-0123456789" })
        checkout.open(code)
        runCurrent()
        gateway.lookups.last().complete(found())
        runCurrent()
        checkout.pay(payer) // no user is confirmed yet: the slot has no owner
        runCurrent()
        gateway.initializes.last().complete(InitializeOutcome.Failed(FailureKind.Network))
        runCurrent()

        checkout.bindOwner("u1") // /me confirms the merchant
        checkout.explicitSignOut()

        assertNull("the signing-out user's attempt must not survive for the next person", store.load(code))
    }
}
