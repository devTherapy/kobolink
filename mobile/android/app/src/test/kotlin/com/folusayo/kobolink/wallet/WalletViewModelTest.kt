package com.folusayo.kobolink.wallet

import java.net.SocketTimeoutException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The wiring above [SendFlow] and [WalletHome]: what survives leaving the
 * send screen, and what a finished or failed payment does to the balance.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class WalletViewModelTest {

    private val gateway = FakeGateway()
    private var keys = 0
    private val unknownOutcome = TransferResult.Failed(classifyTransferFailure(null, null, SocketTimeoutException()))

    @Before
    fun setMain() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun resetMain() {
        Dispatchers.resetMain()
    }

    private fun viewModel(store: PendingAttemptStore = InMemoryPendingAttemptStore()) =
        WalletViewModel(gateway, newKey = { "key-${++keys}-0123456789" }, pending = store)

    private fun WalletViewModel.sendGoodForm() {
        openSend()
        send.edit(SendForm(phone = "08031234567", amount = "2500", note = ""))
        send.submit()
        send.confirm()
    }

    // ---- an unresolved payment survives leaving the screen ----

    @Test
    fun `unknown outcome - Back - open Send again - the same attempt, key and request are surfaced`() {
        gateway.transferResults += unknownOutcome
        val vm = viewModel()
        vm.sendGoodForm()
        val first = (vm.send.state.value.phase as SendPhase.Failed).attempt

        vm.back()
        assertEquals(WalletRoute.Home, vm.route.value)
        vm.openSend()

        assertEquals(WalletRoute.Send, vm.route.value)
        val phase = vm.send.state.value.phase as SendPhase.Failed
        assertEquals("the person must resolve the old payment first", first, phase.attempt)

        gateway.transferResults += TransferResult.Sent(transferResponse("p_1", 250_000, 750_000))
        vm.send.tryAgain()
        assertEquals(2, gateway.transferCalls.size)
        assertEquals("replayed under the same key", gateway.transferCalls[0], gateway.transferCalls[1])
        assertEquals(1, keys)
    }

    @Test
    fun `a scan while a payment is unresolved does not start a second payment`() {
        gateway.transferResults += unknownOutcome
        val vm = viewModel()
        vm.sendGoodForm()
        vm.back()

        vm.openSend(ScannedPayee("+2349012345678", "Someone Else", 500_000L))

        val phase = vm.send.state.value.phase as SendPhase.Failed
        assertEquals("+2348031234567", phase.attempt.toPhone)
    }

    @Test
    fun `discarding says the person checked, and only then is the form free again`() {
        gateway.transferResults += unknownOutcome
        val store = InMemoryPendingAttemptStore()
        val vm = viewModel(store)
        vm.sendGoodForm()
        vm.back()

        vm.discardUnresolvedPayment()
        vm.openSend()

        assertEquals(SendPhase.Editing, vm.send.state.value.phase)
        assertNull(store.load())
    }

    @Test
    fun `the unresolved attempt is rebuilt from the store after the process died`() {
        gateway.transferResults += unknownOutcome
        val store = InMemoryPendingAttemptStore()
        val before = viewModel(store)
        before.sendGoodForm()
        val attempt = (before.send.state.value.phase as SendPhase.Failed).attempt

        val after = viewModel(store) // a new process: new ViewModel, same saved state
        assertEquals(WalletRoute.Home, after.route.value)
        assertEquals(attempt, after.pendingAttempt.value)

        after.openSend()
        val phase = after.send.state.value.phase as SendPhase.Failed
        assertEquals(attempt, phase.attempt)
        assertEquals(TransferFailureKind.Interrupted, phase.failure.kind)
        assertEquals(MoneyMoved.Unknown, phase.failure.moneyMoved)

        gateway.transferResults += TransferResult.Sent(transferResponse("p_1", 250_000, 750_000))
        after.send.tryAgain()
        assertEquals("replayed under the ORIGINAL key", attempt.key, gateway.transferCalls.last().key)
        assertNull("settled, nothing left to resolve", store.load())
    }

    @Test
    fun `a definite no, or a success, leaves nothing pending`() {
        val store = InMemoryPendingAttemptStore()
        val vm = viewModel(store)
        gateway.transferResults += TransferResult.Failed(TransferFailure(TransferFailureKind.RecipientNotFound, MoneyMoved.No))
        vm.sendGoodForm()
        assertNull(store.load())

        gateway.transferResults += TransferResult.Sent(transferResponse("p_1", 250_000, 750_000))
        vm.send.editAgain()
        vm.send.submit()
        vm.send.confirm()
        assertTrue(vm.send.state.value.phase is SendPhase.Sent)
        assertNull(store.load())
    }

    @Test
    fun `an in-flight payment is also remembered, in case the process dies mid-request`() {
        val store = InMemoryPendingAttemptStore()
        val vm = viewModel(store)
        gateway.gate = kotlinx.coroutines.CompletableDeferred()
        gateway.transferResults += TransferResult.Sent(transferResponse("p_1", 250_000, 750_000))
        vm.sendGoodForm()

        assertTrue(vm.send.state.value.phase is SendPhase.Sending)
        assertEquals("key-1-0123456789", store.load()?.key)
    }

    @Test
    fun `sign-out forgets the unresolved payment`() {
        gateway.transferResults += unknownOutcome
        val store = InMemoryPendingAttemptStore()
        val vm = viewModel(store)
        vm.sendGoodForm()

        vm.onSignedOut()

        assertNull(store.load())
        assertEquals(SendPhase.Editing, vm.send.state.value.phase)
    }

    // ---- the balance after a payment ----

    @Test
    fun `insufficient funds refreshes the balance, since the one shown was wrong`() {
        gateway.transferResults += TransferResult.Failed(TransferFailure(TransferFailureKind.InsufficientFunds, MoneyMoved.No))
        val vm = viewModel()
        vm.openSend()
        vm.send.edit(SendForm(phone = "08031234567", amount = "2500"))
        val before = gateway.walletCalls
        vm.send.submit()
        vm.send.confirm()

        assertEquals(before + 1, gateway.walletCalls)
    }

    @Test
    fun `Send another refreshes the balance`() {
        gateway.transferResults += TransferResult.Sent(transferResponse("p_1", 250_000, 750_000))
        val vm = viewModel()
        vm.sendGoodForm()
        val callsAfterSend = gateway.walletCalls

        vm.openSend()

        assertTrue(gateway.walletCalls > callsAfterSend)
    }
}
