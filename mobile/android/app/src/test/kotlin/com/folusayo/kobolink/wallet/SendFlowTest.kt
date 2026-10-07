package com.folusayo.kobolink.wallet

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The send-money state machine. The properties that matter for money: one tap
 * is one request, a key identifies one payment, and an unknown outcome can be
 * replayed but never edited into a second payment.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SendFlowTest {

    private val goodForm = SendForm(phone = "0803 123 4567", amount = "2,500", note = "rent", payeeName = "Ada Obi")

    private class Harness(scope: kotlinx.coroutines.CoroutineScope, val gateway: FakeGateway = FakeGateway()) {
        var keyCounter = 0
        val sent = mutableListOf<String>()
        val flow = SendFlow(gateway, scope, newKey = { "key-${++keyCounter}-0123456789" }, onSent = { sent += it.transaction.postingId })
        val phase get() = flow.state.value.phase
    }

    private fun TestScope.harness() = Harness(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.test.UnconfinedTestDispatcher(testScheduler)))

    private val success = TransferResult.Sent(transferResponse("p_1", 250_000, 750_000))

    @Test
    fun `an invalid form does not reach confirmation and starts showing errors`() = runTest {
        val h = harness()
        h.flow.start(SendForm(phone = "123", amount = ""))
        h.flow.submit()

        assertEquals(SendPhase.Editing, h.phase)
        assertTrue(h.flow.state.value.showErrors)
        assertTrue(h.gateway.transferCalls.isEmpty())
    }

    @Test
    fun `errors stay quiet until the first attempt`() = runTest {
        val h = harness()
        h.flow.start(SendForm())
        h.flow.edit(SendForm(phone = "08"))
        assertFalse(h.flow.state.value.showErrors)
    }

    @Test
    fun `a valid form asks for confirmation and sends nothing yet`() = runTest {
        val h = harness()
        h.flow.start(goodForm)
        h.flow.submit()

        val confirming = h.phase as SendPhase.Confirming
        assertEquals("+2348031234567", confirming.attempt.toPhone)
        assertEquals(250_000L, confirming.attempt.amountKobo)
        assertEquals("rent", confirming.attempt.note)
        assertEquals("Ada Obi", confirming.attempt.payeeName)
        assertTrue(h.gateway.transferCalls.isEmpty())
    }

    @Test
    fun `cancelling the confirmation returns to the form with the entries intact`() = runTest {
        val h = harness()
        h.flow.start(goodForm)
        h.flow.submit()
        h.flow.cancelConfirmation()

        assertEquals(SendPhase.Editing, h.phase)
        assertEquals(goodForm, h.flow.state.value.form)
    }

    @Test
    fun `confirming sends exactly the confirmed request under the attempt key and reports success`() = runTest {
        val h = harness()
        h.gateway.transferResults += success
        h.flow.start(goodForm)
        h.flow.submit()
        h.flow.confirm()
        advanceUntilIdle()

        assertEquals(listOf(FakeGateway.TransferCall("key-1-0123456789", "+2348031234567", 250_000L, "rent")), h.gateway.transferCalls)
        assertTrue(h.phase is SendPhase.Sent)
        assertEquals(listOf("p_1"), h.sent)
    }

    @Test
    fun `a double tap on confirm sends one request`() = runTest {
        val h = harness()
        h.gateway.transferResults += success
        h.gateway.gate = CompletableDeferred()
        h.flow.start(goodForm)
        h.flow.submit()

        h.flow.confirm()
        h.flow.confirm()
        h.flow.confirm()
        advanceUntilIdle()

        assertTrue(h.phase is SendPhase.Sending)
        assertEquals(1, h.gateway.transferCalls.size)

        h.gateway.gate!!.complete(Unit)
        advanceUntilIdle()
        assertEquals(1, h.gateway.transferCalls.size)
        assertTrue(h.phase is SendPhase.Sent)
    }

    @Test
    fun `the form cannot be edited or resubmitted while a request is in flight`() = runTest {
        val h = harness()
        h.gateway.transferResults += success
        h.gateway.gate = CompletableDeferred()
        h.flow.start(goodForm)
        h.flow.submit()
        h.flow.confirm()
        advanceUntilIdle()

        h.flow.edit(goodForm.copy(amount = "999"))
        h.flow.submit()
        advanceUntilIdle()

        assertEquals(goodForm, h.flow.state.value.form)
        assertEquals(1, h.gateway.transferCalls.size)
    }

    @Test
    fun `insufficient funds - no money moved - edit and resend uses a NEW key`() = runTest {
        val h = harness()
        h.gateway.transferResults += TransferResult.Failed(TransferFailure(TransferFailureKind.InsufficientFunds, MoneyMoved.No))
        h.gateway.transferResults += success
        h.flow.start(goodForm)
        h.flow.submit()
        h.flow.confirm()
        advanceUntilIdle()

        val failed = h.phase as SendPhase.Failed
        assertEquals(MoneyMoved.No, failed.failure.moneyMoved)

        h.flow.editAgain()
        assertEquals(SendPhase.Editing, h.phase)
        assertEquals(goodForm, h.flow.state.value.form)

        h.flow.edit(goodForm.copy(amount = "1,000"))
        h.flow.submit()
        h.flow.confirm()
        advanceUntilIdle()

        assertEquals(2, h.gateway.transferCalls.size)
        assertNotEquals("a new payment must not reuse the old key", h.gateway.transferCalls[0].key, h.gateway.transferCalls[1].key)
        assertEquals(100_000L, h.gateway.transferCalls[1].amountKobo)
        assertTrue(h.phase is SendPhase.Sent)
    }

    @Test
    fun `an unknown outcome replays the IDENTICAL request under the SAME key`() = runTest {
        val h = harness()
        val timeout = classifyTransferFailure(null, null, java.net.SocketTimeoutException())
        h.gateway.transferResults += TransferResult.Failed(timeout)
        h.gateway.transferResults += success
        h.flow.start(goodForm)
        h.flow.submit()
        h.flow.confirm()
        advanceUntilIdle()
        assertEquals(MoneyMoved.Unknown, (h.phase as SendPhase.Failed).failure.moneyMoved)

        h.flow.tryAgain()
        advanceUntilIdle()

        assertEquals(2, h.gateway.transferCalls.size)
        assertEquals(h.gateway.transferCalls[0], h.gateway.transferCalls[1])
        assertTrue(h.phase is SendPhase.Sent)
        assertEquals("only one new key was ever made", 1, h.keyCounter)
    }

    @Test
    fun `after an unknown outcome the form cannot be reopened to pay a different amount`() = runTest {
        val h = harness()
        h.gateway.transferResults += TransferResult.Failed(classifyTransferFailure(500, null, null))
        h.flow.start(goodForm)
        h.flow.submit()
        h.flow.confirm()
        advanceUntilIdle()

        val before = h.phase
        h.flow.editAgain()

        assertEquals("editing an unknown outcome could pay twice", before, h.phase)
        h.flow.edit(goodForm.copy(amount = "999"))
        h.flow.submit()
        assertEquals(before, h.phase)
    }

    @Test
    fun `offline before sending is a fresh payment on retry - new key, same details`() = runTest {
        val h = harness()
        h.gateway.transferResults += TransferResult.Failed(classifyTransferFailure(null, null, java.net.UnknownHostException()))
        h.gateway.transferResults += success
        h.flow.start(goodForm)
        h.flow.submit()
        h.flow.confirm()
        advanceUntilIdle()

        h.flow.tryAgain()
        advanceUntilIdle()

        assertEquals(2, h.gateway.transferCalls.size)
        assertNotEquals(h.gateway.transferCalls[0].key, h.gateway.transferCalls[1].key)
        assertEquals(h.gateway.transferCalls[0].copy(key = ""), h.gateway.transferCalls[1].copy(key = ""))
    }

    @Test
    fun `a failure that is the person's mistake cannot be 'tried again' unchanged`() = runTest {
        val h = harness()
        h.gateway.transferResults += TransferResult.Failed(TransferFailure(TransferFailureKind.RecipientNotFound, MoneyMoved.No))
        h.flow.start(goodForm)
        h.flow.submit()
        h.flow.confirm()
        advanceUntilIdle()

        h.flow.tryAgain()
        advanceUntilIdle()

        assertEquals("there is nothing to retry; the number is wrong", 1, h.gateway.transferCalls.size)
        assertTrue(h.phase is SendPhase.Failed)
    }

    @Test
    fun `a success reports to the home exactly once`() = runTest {
        val h = harness()
        h.gateway.transferResults += success
        h.flow.start(goodForm)
        h.flow.submit()
        h.flow.confirm()
        advanceUntilIdle()
        h.flow.tryAgain() // nothing to retry after a success
        h.flow.confirm()
        advanceUntilIdle()

        assertEquals(listOf("p_1"), h.sent)
        assertEquals(1, h.gateway.transferCalls.size)
    }

    @Test
    fun `start resets everything for a new payment`() = runTest {
        val h = harness()
        h.gateway.transferResults += success
        h.flow.start(goodForm)
        h.flow.submit()
        h.flow.confirm()
        advanceUntilIdle()

        h.flow.start()

        assertEquals(SendState(), h.flow.state.value)
    }
}
