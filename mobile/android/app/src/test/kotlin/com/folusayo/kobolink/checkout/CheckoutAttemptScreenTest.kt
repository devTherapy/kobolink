package com.folusayo.kobolink.checkout

import com.folusayo.kobolink.auth.SessionChange
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M3 fresh attempt, review round 1. Once a payment's outcome is unknown there is exactly ONE open attempt for the
 * link, and the only ways forward are the same-key retry (the identical request) or the confirmed "Start a new
 * payment". The iOS I3 rule: ANY outcome-unknown phase, in the run that sent it or remembered from an earlier one,
 * shows the attempt with NO form, so the key it was sent under cannot be replaced by an edit.
 *
 * RED FIRST: these were written against 6569c70 and the ones marked (red) failed there.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CheckoutAttemptScreenTest {

    private val corrected = PayerInput(1_500_000, "Tunde Bello", "tunde@example.org")

    // ---- 1. a failure in the SAME run -------------------------------------------------------------------------

    @Test
    fun `(red) after a failure in the same run nothing but the stored request can be sent`() = runTest {
        val rig = CheckoutRig(this)
        rig.makeAttempt(outcome = InitializeOutcome.Failed(FailureKind.Network))
        val stored = rig.store.snapshot.single()

        // No input of any kind can start another send: not the very same details, not a corrected one.
        rig.pay(PayerInput(stored.request.amountKobo, stored.request.payerName, stored.request.payerEmail))
        rig.pay(corrected)
        assertEquals("pay() sends nothing while an attempt is open", 1, rig.sends.size)
        assertTrue(rig.pay is PayPhase.Failed)

        // The one thing that does send is the retry, and it sends exactly what was stored, under the stored key.
        rig.controller.retry()
        rig.settle()
        assertEquals(2, rig.sends.size)
        assertEquals(stored.request to stored.key, rig.sends[1])
    }

    @Test
    fun `(red) a changed request after a failure cannot be sent, so the first key is never replaced`() = runTest {
        val rig = CheckoutRig(this)
        rig.makeAttempt(outcome = InitializeOutcome.Failed(FailureKind.Network))
        val firstKey = rig.store.snapshot.single().key

        rig.pay(corrected) // a form edit is impossible; if it got here anyway it must not mint a key

        assertEquals("nothing else was sent", 1, rig.sends.size)
        assertEquals(1, rig.keysMade)
        assertEquals(firstKey, rig.store.snapshot.single().key)
        assertEquals("Tunde Bello", rig.store.snapshot.single().request.payerName)
        assertEquals("tunde@example.com", rig.store.snapshot.single().request.payerEmail)
    }

    @Test
    fun `a failure in the same run is retried with the same key and the identical request`() = runTest {
        val rig = CheckoutRig(this)
        rig.makeAttempt(outcome = InitializeOutcome.Failed(FailureKind.Server))

        rig.controller.retry()
        rig.answerSend(InitializeOutcome.Started(CK.reference, 1_500_000))

        assertEquals(2, rig.sends.size)
        assertEquals(rig.sends[0], rig.sends[1])
        assertEquals(1, rig.keysMade)
        assertEquals(PayPhase.Started(CK.reference, 1_500_000), rig.pay)
    }

    @Test
    fun `(red) a changed open amount after a failure cannot be sent either`() = runTest {
        val rig = CheckoutRig(this)
        rig.openPayable(amountKobo = null)
        rig.fillForm(amount = "15000")
        rig.pay(PayerInput(1_500_000, payer.name, payer.email))
        rig.answerSend(InitializeOutcome.Failed(FailureKind.Network))

        rig.pay(PayerInput(2_000_000, payer.name, payer.email))

        assertEquals(1, rig.sends.size)
        assertEquals(1, rig.keysMade)
    }

    @Test
    fun `Start a new payment confirmed after an in-run failure opens an empty form, and only then is a new key made`() = runTest {
        val rig = CheckoutRig(this)
        rig.makeAttempt(outcome = InitializeOutcome.Failed(FailureKind.Network))

        rig.controller.startOver()
        rig.answerLookup()

        assertEquals(PayPhase.Idle, rig.pay)
        assertTrue(rig.form.isEmpty)
        assertTrue(rig.store.snapshot.isEmpty())
        rig.pay(corrected)
        assertEquals(2, rig.keysMade)
        assertTrue(rig.sends[0].second != rig.sends[1].second)
    }

    // ---- 2. a remembered attempt on a link whose price changed --------------------------------------------------

    @Test
    fun `(red) a remembered attempt is shown whatever the link costs now, and its retry is settled by the server`() = runTest {
        val first = CheckoutRig(this)
        first.makeAttempt()
        first.finish()

        val second = first.relaunched()
        second.controller.open(CK.codeA)
        second.answerLookup(amountKobo = 1_800_000) // repriced meanwhile
        assertEquals(FailureKind.Interrupted, (second.pay as PayPhase.Failed).kind)
        assertTrue(second.pay!!.showsAttempt)

        second.controller.retry()
        second.answerSend(
            InitializeOutcome.Rejected(refusal(RejectionKind.AmountMismatch, "That amount does not match this link.")),
        )
        // The refusal is the server's final word for that key: the slot goes, and the payer is told the new price.
        assertTrue(second.store.snapshot.isEmpty())
        second.answerLookup(amountKobo = 1_800_000)
        assertEquals(PayPhase.PriceChanged(1_800_000), second.pay)
        assertEquals("the stored request was replayed under its own key", "run1-key-0-0123456789", second.sends.single().second)
    }

    // ---- 3c. Try again must never do nothing --------------------------------------------------------------------

    @Test
    fun `(red) Try again on an attempt another user made surfaces the blocked state instead of doing nothing`() = runTest {
        val first = CheckoutRig(this, owner = CK.session(CK.userOne))
        first.makeAttempt()
        first.finish()
        val second = first.relaunched(owner = CK.unconfirmed)
        second.controller.open(CK.codeA)
        second.answerLookup()
        second.store.fail(StoreOperation.Remove)
        second.controller.sessionDidChange(SessionChange.Resolved(CK.userTwo)) // u1's slot cannot be removed

        second.controller.retry()
        second.settle()

        assertEquals(CheckoutState.StorageBlocked(CK.codeA, StorageBlock.CannotClear), second.state)
        assertFalse("and nothing was sent under the other user's key", second.sends.isNotEmpty())
    }
}
