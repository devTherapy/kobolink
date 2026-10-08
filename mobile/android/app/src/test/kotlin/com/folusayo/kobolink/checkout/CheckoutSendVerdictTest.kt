package com.folusayo.kobolink.checkout

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What an answer to `POST /api/checkout/initialize` lets the app conclude about the attempt it belongs to: the Kotlin
 * twin of iOS's `SendVerdict`. A refusal that applies only to the REPLAY says nothing about whether the FIRST send
 * created a checkout, so it must not end the attempt: ending it unlocks a new key, and a new key is a second pending
 * checkout for one payment.
 *
 * The API validates the body BEFORE the idempotency layer, so `validation_failed` is never stored under a key;
 * `idempotency_mismatch` proves the first send WAS recorded; Nest's route-level 404/409/422 carry no `moneyMoved`.
 * Only `not_found`/404, `link_not_payable`/409 and `amount_mismatch`/422, each saying `moneyMoved: false`, are answers
 * the server stores under the key, and so settle the attempt; `validation_failed` settles only the very first send.
 *
 * RED FIRST: the (red) tests were written against 11a03ab and failed there.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CheckoutSendVerdictTest {

    private fun CheckoutRig.attemptKey() = store.snapshot.single().key

    private fun CheckoutRig.assertAttemptKept(key: String, label: String) {
        assertEquals("$label: the slot still holds the first key", key, store.snapshot.singleOrNull()?.key)
        assertTrue("$label: the screen is still the attempt", pay is PayPhase.Failed)
    }

    @Test
    fun `(red) a validation_failed on a REPLAY keeps the attempt and its key`() = runTest {
        val rig = CheckoutRig(this)
        rig.makeAttempt()
        val key = rig.attemptKey()

        rig.controller.retry()
        rig.answerSend(InitializeOutcome.Rejected(Rejection(RejectionKind.ValidationFailed, "Validation failed.", mapOf(PayerField.Email to "x"))))

        rig.assertAttemptKept(key, "replay validation_failed")
    }

    @Test
    fun `(red) idempotency_mismatch keeps the attempt, it proves the first send was recorded`() = runTest {
        val rig = CheckoutRig(this)
        rig.makeAttempt()
        val key = rig.attemptKey()

        rig.controller.retry()
        rig.answerSend(InitializeOutcome.Rejected(Rejection(RejectionKind.Other, "Idempotency key reused with a different request.")))

        rig.assertAttemptKept(key, "idempotency_mismatch")
    }

    @Test
    fun `(red) a route-level 404 with no moneyMoved does not settle the attempt, on a replay or on the first send`() = runTest {
        val replay = CheckoutRig(this)
        replay.makeAttempt()
        val key = replay.attemptKey()
        replay.controller.retry()
        replay.answerSend(InitializeOutcome.Rejected(Rejection(RejectionKind.NotFound, "Not found.")))
        replay.assertAttemptKept(key, "replayed route-level 404")

        val first = CheckoutRig(this)
        first.openPayable()
        first.fillForm()
        first.pay()
        first.answerSend(InitializeOutcome.Rejected(Rejection(RejectionKind.NotFound, "Not found.")))
        assertEquals("a first-send route-level 404 is unsettled too", 1, first.store.snapshot.size)
        assertTrue(first.pay is PayPhase.Failed)
    }

    // ---- the verdict itself -------------------------------------------------------------------------------------

    private val request = CK.request()
    private val trio = listOf(RejectionKind.NotFound, RejectionKind.LinkNotPayable, RejectionKind.AmountMismatch)

    private fun verdict(rejection: Rejection, first: Boolean) =
        sendVerdict(InitializeOutcome.Rejected(rejection), request, first)

    @Test
    fun `not_found, link_not_payable and amount_mismatch with their own status and moneyMoved false settle, first send or replay`() {
        for (kind in trio) {
            for (first in listOf(true, false)) {
                val rejection = refusal(kind, "no")
                assertEquals("$kind first=$first", SendVerdict.Settled(rejection), verdict(rejection, first))
            }
        }
    }

    @Test
    fun `those same refusals do NOT settle without moneyMoved false, or with a status the idempotency layer never stores`() {
        for (kind in trio) {
            for (moneyMoved in listOf<Boolean?>(null, true)) {
                assertEquals("$kind moneyMoved=$moneyMoved", SendVerdict.Unsettled(FailureKind.Refused), verdict(refusal(kind, "no", moneyMoved = moneyMoved), false))
            }
            for (status in listOf(0, 200, 400, 401, 403, 500)) {
                if (status == statusOf(kind)) continue
                assertEquals("$kind status=$status", SendVerdict.Unsettled(FailureKind.Refused), verdict(refusal(kind, "no", httpStatus = status), false))
            }
        }
    }

    @Test
    fun `validation_failed settles only the very first send`() {
        val rejection = refusal(RejectionKind.ValidationFailed, "Validation failed.", moneyMoved = null)
        assertEquals(SendVerdict.Rejected(rejection), verdict(rejection, first = true))
        assertEquals(SendVerdict.Rejected(refusal(RejectionKind.ValidationFailed, "v", moneyMoved = false)), verdict(refusal(RejectionKind.ValidationFailed, "v", moneyMoved = false), true))
        assertEquals(SendVerdict.Unsettled(FailureKind.Refused), verdict(rejection, first = false))
        assertEquals("never when the server says money moved", SendVerdict.Unsettled(FailureKind.Refused), verdict(refusal(RejectionKind.ValidationFailed, "v", moneyMoved = true), true))
        assertEquals("only as a 400", SendVerdict.Unsettled(FailureKind.Refused), verdict(refusal(RejectionKind.ValidationFailed, "v", moneyMoved = null, httpStatus = 422), true))
    }

    @Test
    fun `every other refusal is unsettled, first send or replay`() {
        for (first in listOf(true, false)) {
            assertEquals(SendVerdict.Unsettled(FailureKind.Refused), verdict(refusal(RejectionKind.Other, "mismatch", moneyMoved = null, httpStatus = 422), first))
            assertEquals(SendVerdict.Unsettled(FailureKind.Refused), verdict(refusal(RejectionKind.Other, "unauthenticated", moneyMoved = null, httpStatus = 401), first))
        }
    }

    @Test
    fun `a failed call is unsettled with its own kind, and a started reply must be for THIS request`() {
        for (kind in FailureKind.entries) {
            assertEquals(SendVerdict.Unsettled(kind), sendVerdict(InitializeOutcome.Failed(kind), request, true))
        }
        assertEquals(SendVerdict.Started(CK.reference, 1_500_000), sendVerdict(InitializeOutcome.Started(CK.reference, 1_500_000, CK.codeA), request, false))
        assertEquals(SendVerdict.Started(CK.reference, 1_500_000), sendVerdict(InitializeOutcome.Started(CK.reference, 1_500_000), request, false))
        assertEquals(SendVerdict.Unsettled(FailureKind.Unreadable), sendVerdict(InitializeOutcome.Started(CK.reference, 1_500_000, CK.codeB), request, false))
        assertEquals(SendVerdict.Unsettled(FailureKind.Unreadable), sendVerdict(InitializeOutcome.Started(CK.reference, 1_500_001, CK.codeA), request, false))
    }

    // ---- through the controller ---------------------------------------------------------------------------------

    @Test
    fun `validation_failed on the first send ever settles it, the form stays for the payer to correct`() = runTest {
        val rig = CheckoutRig(this)
        rig.openPayable()
        rig.fillForm()
        rig.pay()
        rig.answerSend(InitializeOutcome.Rejected(refusal(RejectionKind.ValidationFailed, "Validation failed.", mapOf(PayerField.Email to "x"), moneyMoved = null)))

        assertTrue(rig.pay is PayPhase.Rejected)
        assertTrue("nothing exists under that key, so nothing is kept", rig.store.snapshot.isEmpty())
        assertEquals("tunde@example.com", rig.form.email)
    }

    @Test
    fun `a settled refusal on a REPLAY ends the attempt just the same`() = runTest {
        val rig = CheckoutRig(this)
        rig.makeAttempt()
        rig.controller.retry()
        rig.answerSend(InitializeOutcome.Rejected(refusal(RejectionKind.NotFound, "No link with that code.")))

        assertEquals(CheckoutState.NotFound(CK.codeA), rig.state)
        assertTrue(rig.store.snapshot.isEmpty())
    }

    @Test
    fun `a restart cannot turn a replay into a first send, so a remembered attempt's validation refusal keeps it`() = runTest {
        val first = CheckoutRig(this)
        first.makeAttempt()
        first.finish()
        val second = first.relaunched()
        second.controller.open(CK.codeA)
        second.answerLookup()

        second.controller.retry()
        second.answerSend(InitializeOutcome.Rejected(refusal(RejectionKind.ValidationFailed, "Validation failed.", moneyMoved = null)))

        assertEquals("run1-key-0-0123456789", second.store.snapshot.single().key)
        assertTrue(second.pay is PayPhase.Failed)
    }

    @Test
    fun `(red) a reply about some other payment is not an answer to this one`() = runTest {
        val rig = CheckoutRig(this)
        rig.openPayable()
        rig.fillForm()
        rig.pay()

        rig.answerSend(InitializeOutcome.Started(CK.reference, 1_999_999)) // the request asked for 1_500_000

        assertTrue("not accepted as started", rig.pay is PayPhase.Failed)
        assertNull("and no reference was recorded", rig.store.snapshot.single().reference)
    }
}
