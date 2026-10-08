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
