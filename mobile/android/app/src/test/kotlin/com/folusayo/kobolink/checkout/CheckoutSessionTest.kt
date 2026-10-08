package com.folusayo.kobolink.checkout

import com.folusayo.kobolink.auth.SessionChange
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Signing out and changing user: the Kotlin port of iOS's `CheckoutSessionStateTests` (feature I3), plus the two
 * defects the M3 reviewers recorded against Android (round 4):
 *
 * (A) sign-out and a confirmed user change left the previous person's name, e-mail and amount in the form, so the next
 *     person who opened the same link could send that exact request under a NEW key while the earlier outcome was
 *     unknown;
 * (B) an attempt made while the session was still resolving or offline had no owner, so neither sign-out nor a user
 *     change ever removed it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CheckoutSessionTest {

    private val userOne = CK.userOne
    private val userTwo = CK.userTwo

    /** A signed-in merchant opens a link, types a payer's details, and starts a payment that cannot be confirmed. */
    private fun TestScope.merchantAttempt(owner: AttemptOwner = CK.session(userOne), code: String = CK.codeA): CheckoutRig {
        val rig = CheckoutRig(this, owner = owner)
        rig.makeAttempt(code)
        return rig
    }

    private fun signOut(rig: CheckoutRig) {
        rig.controller.sessionDidChange(SessionChange.SignedOutByChoice)
        rig.settle()
    }

    // ---- (A) the form -----------------------------------------------------------------------------------------

    @Test
    fun `explicit sign-out empties the form fields, the amount included, in memory`() = runTest {
        val rig = CheckoutRig(this, owner = CK.session(userOne))
        rig.openPayable(amountKobo = null)
        rig.fillForm(amount = "5000")
        rig.form.errors = mapOf(PayerField.Email to "x")
        rig.form.editedSinceRefusal = setOf(PayerField.Name)

        rig.controller.sessionDidChange(SessionChange.SignedOutByChoice)

        // Synchronously: nothing has been awaited, no lookup has been answered.
        assertEquals("", rig.form.name)
        assertEquals("", rig.form.email)
        assertEquals("", rig.form.amountText)
        assertTrue(rig.form.errors.isEmpty())
        assertTrue(rig.form.editedSinceRefusal.isEmpty())
        // The link is shown again, fresh, to whoever is here now.
        rig.answerLookup(amountKobo = null)
        assertEquals(CheckoutState.Loaded(link(amountKobo = null), LinkAvailability.Payable, PayPhase.Idle), rig.state)
    }

    @Test
    fun `the next person to open the same link after a sign-out cannot re-send the previous request, there is nothing to send`() = runTest {
        val rig = merchantAttempt()
        signOut(rig)
        assertTrue(rig.store.snapshot.isEmpty())
        rig.answerLookup()
        assertTrue(rig.form.isEmpty)

        rig.controller.retry()
        rig.settle()
        assertEquals("a retry has nothing to resend", 1, rig.sends.size)

        // A second person's own payment is a new attempt with a new key.
        rig.fillForm(name = "Someone Else", email = "else@example.test")
        rig.pay(PayerInput(1_500_000, "Someone Else", "else@example.test"))
        rig.answerSend(InitializeOutcome.Failed(FailureKind.Network))
        assertEquals(2, rig.sends.map { it.second }.toSet().size)
        assertEquals("Someone Else", rig.sends[1].first.payerName)
    }

    @Test
    fun `an answer that arrives after sign-out is dropped, it does not bring the attempt back`() = runTest {
        // A call that does not notice cancellation: its answer arrives after the controller has moved on.
        val rig = CheckoutRig(this, owner = CK.session(userOne), ignoreCancellation = true)
        rig.openPayable()
        rig.fillForm()
        rig.pay()
        assertEquals("in flight", 1, rig.sends.size)

        signOut(rig)
        assertTrue(rig.store.snapshot.isEmpty())
        rig.gateway.initializes.last().complete(InitializeOutcome.Started(CK.reference, 1_500_000))
        rig.settle()

        assertTrue(rig.store.snapshot.isEmpty())
        assertFalse((rig.state as? CheckoutState.Loaded)?.pay is PayPhase.Started)
    }

    @Test
    fun `Back empties the form, so it can never land on a stale one`() = runTest {
        val rig = CheckoutRig(this)
        rig.openPayable()
        rig.fillForm()

        rig.controller.close()

        assertTrue(rig.form.isEmpty)
        assertEquals(CheckoutState.Idle, rig.state)
    }

    @Test
    fun `a different link starts with an empty form, and the same link re-opened keeps what was typed`() = runTest {
        val rig = CheckoutRig(this)
        rig.openPayable()
        rig.fillForm()

        rig.controller.open(CK.codeA) // a re-tap of the very link on screen
        assertEquals(payer.name, rig.form.name)

        rig.controller.open(CK.codeB)
        assertTrue(rig.form.isEmpty)
    }

    // ---- (B) who owns an attempt -------------------------------------------------------------------------------

    @Test
    fun `a payer's attempt survives a merchant signing out, the merchant's own does not`() = runTest {
        val payerRig = merchantAttempt(owner = AttemptOwner.Payer)
        signOut(payerRig)
        assertEquals(1, payerRig.store.snapshot.size)
        payerRig.answerLookup()
        assertEquals(PayPhase.Failed(FailureKind.Interrupted, payerRig.sends.single().first), payerRig.pay)

        val merchant = merchantAttempt(owner = CK.session(userOne))
        signOut(merchant)
        assertTrue(merchant.store.snapshot.isEmpty())
    }

    @Test
    fun `sign-out removes every session attempt on the device, on other links too`() = runTest {
        val rig = merchantAttempt(code = CK.codeA)
        rig.makeAttempt(CK.codeB)
        assertEquals(2, rig.store.snapshot.size)

        signOut(rig)

        assertTrue(rig.store.snapshot.isEmpty())
    }

    @Test
    fun `an attempt made while the session was resolving is owned by nobody yet, then by the user the check confirms`() = runTest {
        val rig = merchantAttempt(owner = CK.unconfirmed)
        assertEquals(CK.unconfirmed, rig.store.snapshot.single().owner)

        rig.controller.sessionDidChange(SessionChange.Resolved(userOne))

        assertEquals(CK.session(userOne), rig.store.snapshot.single().owner)
        // It is still on screen, with its key: confirmation changes nobody's attempt.
        assertTrue(rig.pay is PayPhase.Failed)
        assertEquals(1, rig.keysMade)
        // And now an explicit sign-out removes it.
        signOut(rig)
        assertTrue(rig.store.snapshot.isEmpty())
    }

    @Test
    fun `an attempt made while offline is not an orphan, explicit sign-out removes it before it is ever confirmed`() = runTest {
        val rig = merchantAttempt(owner = CK.unconfirmed)

        signOut(rig)

        assertTrue(rig.store.snapshot.isEmpty())
    }

    @Test
    fun `an involuntary end leaves an unconfirmed attempt where it is, for the same person to resume`() = runTest {
        val rig = merchantAttempt(owner = CK.unconfirmed)

        rig.controller.sessionDidChange(SessionChange.Ended)

        assertEquals(1, rig.store.snapshot.size)
        assertTrue(rig.pay is PayPhase.Failed)
    }

    @Test
    fun `an involuntary end clears neither the attempt nor the form`() = runTest {
        val rig = merchantAttempt(owner = CK.session(userOne))
        rig.fillForm()

        rig.controller.sessionDidChange(SessionChange.Ended)

        assertEquals(1, rig.store.snapshot.size)
        assertEquals(payer.name, rig.form.name)
    }

    @Test
    fun `a different user signing in removes the previous user's CONFIRMED attempt, and the form`() = runTest {
        val rig = merchantAttempt(owner = CK.session(userOne))
        rig.fillForm()
        rig.controller.sessionDidChange(SessionChange.Ended)

        rig.controller.sessionDidChange(SessionChange.SignedIn(userTwo))

        assertTrue(rig.store.snapshot.isEmpty())
        assertTrue(rig.form.isEmpty)
        rig.answerLookup()
        assertEquals(CheckoutState.Loaded(link(), LinkAvailability.Payable, PayPhase.Idle), rig.state)
    }

    @Test
    fun `signing in NEVER drops an unconfirmed attempt, the person who signs in adopts it with its key`() = runTest {
        for (user in listOf(userOne, userTwo)) {
            val rig = merchantAttempt(owner = CK.unconfirmed)
            val key = rig.store.snapshot.single().key
            rig.controller.sessionDidChange(SessionChange.Ended)

            rig.controller.sessionDidChange(SessionChange.SignedIn(user))

            val stored = rig.store.snapshot.single()
            assertEquals(key, stored.key)
            assertEquals(CK.session(user), stored.owner)
        }
    }

    @Test
    fun `the SAME person signing back in after an unknown outcome retries the same request under the same key, not a new one`() = runTest {
        // Cold start with a token that has expired: the link opens while the session is resolving, Pay saves an
        // attempt with no owner, the POST times out, /me answers 401, and the same merchant signs in again.
        val rig = CheckoutRig(this, owner = CK.unconfirmed)
        rig.openPayable()
        rig.fillForm()
        rig.pay()
        rig.answerSend(InitializeOutcome.Failed(FailureKind.Network))
        rig.controller.sessionDidChange(SessionChange.Ended)
        rig.controller.sessionDidChange(SessionChange.SignedIn(userOne))
        rig.answerLookup()
        assertEquals(FailureKind.Interrupted, (rig.pay as PayPhase.Failed).kind)

        rig.controller.retry()
        rig.answerSend(InitializeOutcome.Started(CK.reference, 1_500_000))

        assertEquals(PayPhase.Started(CK.reference, 1_500_000), rig.pay)
        assertEquals(1, rig.keysMade)
        assertEquals(1, rig.sends.map { it.second }.toSet().size)
        assertEquals(2, rig.sends.size)
        assertEquals(rig.sends[0].first, rig.sends[1].first)
    }

    @Test
    fun `the offline then Try again then 401 then sign-in route keeps the attempt too, with its reference`() = runTest {
        val rig = CheckoutRig(this, owner = CK.unconfirmed)
        rig.makeAttempt(outcome = InitializeOutcome.Started(CK.reference, 1_500_000))

        rig.controller.sessionDidChange(SessionChange.Ended)
        rig.controller.sessionDidChange(SessionChange.SignedIn(userOne))
        rig.answerLookup()

        assertEquals(PayPhase.Started(CK.reference, 1_500_000), rig.pay)
        assertEquals(CK.reference, rig.store.snapshot.single().reference)
    }

    @Test
    fun `if adopting the attempt cannot be saved, the attempt is KEPT and adoption is retried, nothing is swallowed`() = runTest {
        val rig = merchantAttempt(owner = CK.unconfirmed)
        val key = rig.store.snapshot.single().key
        rig.controller.sessionDidChange(SessionChange.Ended)
        rig.store.fail(StoreOperation.Write)

        rig.controller.sessionDidChange(SessionChange.SignedIn(userOne))
        rig.answerLookup()

        assertEquals(1, rig.store.snapshot.size)
        assertEquals(CK.unconfirmed, rig.store.snapshot.single().owner)
        assertEquals(FailureKind.Interrupted, (rig.pay as PayPhase.Failed).kind)

        // Storage recovers; the next time the link is shown, adoption is retried and succeeds.
        rig.store.heal()
        rig.controller.reload()
        rig.answerLookup()
        assertEquals(CK.session(userOne), rig.store.snapshot.single().owner)
        assertEquals(key, rig.store.snapshot.single().key)
        // ... so a later sign-out of that user removes it.
        signOut(rig)
        assertTrue(rig.store.snapshot.isEmpty())
    }

    @Test
    fun `the same user signing in again after an expiry keeps their own confirmed attempt`() = runTest {
        val rig = merchantAttempt(owner = CK.session(userOne))
        rig.controller.sessionDidChange(SessionChange.Ended)
        rig.controller.sessionDidChange(SessionChange.SignedIn(userOne))
        rig.answerLookup()
        assertEquals(1, rig.store.snapshot.size)
        assertEquals(FailureKind.Interrupted, (rig.pay as PayPhase.Failed).kind)

        rig.controller.retry()
        rig.answerSend(InitializeOutcome.Started(CK.reference, 1_500_000))

        assertEquals(PayPhase.Started(CK.reference, 1_500_000), rig.pay)
        assertEquals(1, rig.keysMade)
    }

    @Test
    fun `a payer's attempt is not touched when a merchant signs in`() = runTest {
        val rig = merchantAttempt(owner = AttemptOwner.Payer)

        rig.controller.sessionDidChange(SessionChange.SignedIn(userOne))

        assertEquals(AttemptOwner.Payer, rig.store.snapshot.single().owner)
    }

    @Test
    fun `the check confirming a DIFFERENT user than the last one clears the form and the other user's attempts`() = runTest {
        val rig = merchantAttempt(owner = CK.session(userOne))
        rig.fillForm()
        rig.controller.sessionDidChange(SessionChange.Resolved(userOne))

        rig.controller.sessionDidChange(SessionChange.Resolved(userTwo))

        assertTrue(rig.store.snapshot.isEmpty())
        assertTrue(rig.form.isEmpty)
    }

    @Test
    fun `the check confirming the user does not wipe a form the person is typing into`() = runTest {
        val rig = CheckoutRig(this, owner = CK.unconfirmed)
        rig.openPayable()
        rig.fillForm()

        rig.controller.sessionDidChange(SessionChange.Resolved(userOne))

        assertEquals(payer.name, rig.form.name)
        assertEquals(PayPhase.Idle, rig.pay)
    }

    // ---- a cold start: the slot is found whatever the session is doing --------------------------------------------

    @Test
    fun `a signed-in user's unsettled attempt is found after a cold start, and the check leaves the screen alone`() = runTest {
        for (outcome in listOf<InitializeOutcome?>(null, InitializeOutcome.Failed(FailureKind.Network), InitializeOutcome.Started(CK.reference, 1_500_000))) {
            val first = CheckoutRig(this, owner = CK.session(userOne))
            first.openPayable()
            first.fillForm()
            first.pay()
            if (outcome != null) first.answerSend(outcome)
            first.finish() // process death

            val second = first.relaunched(owner = CK.unconfirmed) // resolving: no user yet
            second.controller.open(CK.codeA)
            second.answerLookup()
            val expected = if (outcome is InitializeOutcome.Started) {
                PayPhase.Started(CK.reference, 1_500_000)
            } else {
                PayPhase.Failed(FailureKind.Interrupted, CK.request(name = payer.name, email = payer.email))
            }
            assertEquals("outcome $outcome", expected, second.pay)

            second.controller.sessionDidChange(SessionChange.Resolved(userOne)) // /me answers

            assertEquals("outcome $outcome", expected, second.pay)
            if (outcome !is InitializeOutcome.Started) {
                second.controller.retry()
                second.settle()
                assertEquals("outcome $outcome: the retry carries the first key", "run1-key-0-0123456789", second.sends.last().second)
            }
            assertEquals("outcome $outcome: no second key was ever minted", 0, second.keysMade)
        }
    }

    @Test
    fun `a different user confirmed at cold start never sees the first one's attempt, and it is gone from disk`() = runTest {
        val first = CheckoutRig(this, owner = CK.session(userOne))
        first.makeAttempt(outcome = InitializeOutcome.Started(CK.reference, 1_500_000))
        first.finish()

        val second = first.relaunched(owner = CK.unconfirmed)
        second.controller.open(CK.codeA)
        second.answerLookup()
        assertEquals(PayPhase.Started(CK.reference, 1_500_000), second.pay) // resolving: shown from the single slot

        second.controller.sessionDidChange(SessionChange.Resolved(userTwo)) // /me says it is someone else
        second.answerLookup()

        assertTrue("u1's slot is gone", second.store.snapshot.isEmpty())
        assertEquals("and is not left on u2's screen", PayPhase.Idle, second.pay)
    }

    @Test
    fun `a payer's request still in the air when someone signs in is abandoned, and its retry carries the same key`() = runTest {
        val rig = CheckoutRig(this, owner = AttemptOwner.Payer)
        rig.openPayable()
        rig.fillForm()
        rig.pay()

        rig.controller.sessionDidChange(SessionChange.SignedIn(userOne))
        rig.answerLookup()
        assertEquals("the payer's attempt is still the payer's", AttemptOwner.Payer, rig.store.snapshot.single().owner)
        assertEquals(FailureKind.Interrupted, (rig.pay as PayPhase.Failed).kind)
        assertTrue(rig.form.isEmpty)

        rig.controller.retry()
        rig.answerSend(InitializeOutcome.Started(CK.reference, 1_500_000))

        assertEquals(PayPhase.Started(CK.reference, 1_500_000), rig.pay)
        assertEquals(1, rig.sends.map { it.second }.toSet().size)
    }

    // ---- a removal that fails is not swallowed ---------------------------------------------------------------------

    @Test
    fun `if sign-out cannot remove an attempt, it is hidden from the next person until it can`() = runTest {
        val rig = merchantAttempt(owner = CK.session(userOne))
        rig.store.fail(StoreOperation.Remove)

        signOut(rig)

        assertEquals(1, rig.store.snapshot.size)
        // The next person opens the link: not the previous user's attempt, and no way to resend it.
        assertEquals(CheckoutState.StorageBlocked(CK.codeA, StorageBlock.CannotClear), rig.state)
        rig.controller.retry()
        rig.settle()
        assertEquals(1, rig.sends.size)
        assertEquals(1, rig.gateway.lookups.size)
        // Storage recovers: the next open removes it and carries on.
        rig.store.heal()
        rig.controller.reload()
        rig.answerLookup()
        assertTrue(rig.store.snapshot.isEmpty())
        assertEquals(PayPhase.Idle, rig.pay)
    }

    @Test
    fun `a payer's attempt on another link is still shown while a sign-out cleanup is outstanding`() = runTest {
        val store = InMemoryPendingCheckoutStore()
        store.save(CK.pending(CK.codeA, owner = CK.session(userOne)))
        store.save(CK.pending(CK.codeB, key = "persisted-key-B-0123456789", owner = AttemptOwner.Payer))
        val rig = CheckoutRig(this, store)
        store.fail(StoreOperation.Remove)

        signOut(rig)
        rig.controller.open(CK.codeB)
        rig.answerLookup(CK.codeB)
        assertEquals(FailureKind.Interrupted, (rig.pay as PayPhase.Failed).kind)

        rig.controller.open(CK.codeA)
        assertEquals(CheckoutState.StorageBlocked(CK.codeA, StorageBlock.CannotClear), rig.state)
    }

    @Test
    fun `a sign-out cleanup that failed is still owed after a restart, the next process does not show the attempt`() = runTest {
        val store = InMemoryPendingCheckoutStore()
        store.save(CK.pending(CK.codeA, owner = CK.session(userOne)))
        store.save(CK.pending(CK.codeB, key = "persisted-key-B-0123456789", owner = AttemptOwner.Payer))
        val first = CheckoutRig(this, store)
        store.fail(StoreOperation.Remove)
        signOut(first)
        assertEquals(2, store.snapshot.size)

        // A new process over the same storage, with the failure still in place: blocked, never shown.
        val second = first.relaunched()
        second.controller.open(CK.codeA)
        assertEquals(CheckoutState.StorageBlocked(CK.codeA, StorageBlock.CannotClear), second.state)
        assertTrue(second.gateway.lookups.isEmpty())
        second.controller.open(CK.codeB)
        second.answerLookup(CK.codeB)
        assertEquals(FailureKind.Interrupted, (second.pay as PayPhase.Failed).kind)

        // Storage recovers: the owed cleanup runs before any slot is presented, and the payer's stays.
        store.heal()
        second.controller.open(CK.codeA)
        second.answerLookup(CK.codeA)
        assertEquals(PayPhase.Idle, second.pay)
        assertEquals(listOf(CK.codeB), store.snapshot.map { it.request.code })

        // And it is not owed any more: a third process shows nothing special, and a NEW session attempt survives.
        val third = second.relaunched(owner = CK.session(userTwo))
        third.makeAttempt(CK.codeA)
        third.controller.open(CK.codeA)
        third.answerLookup(CK.codeA)
        assertTrue(third.pay is PayPhase.Failed)
        assertEquals(2, store.snapshot.size)
    }

    @Test
    fun `an obligation that cannot be reached at cold start blocks the link rather than guessing`() = runTest {
        val store = InMemoryPendingCheckoutStore()
        store.save(CK.pending(CK.codeA, owner = AttemptOwner.Payer))
        store.fail(StoreOperation.Obligation)
        val rig = CheckoutRig(this, store)

        rig.controller.open(CK.codeA)

        assertEquals(CheckoutState.StorageBlocked(CK.codeA, StorageBlock.Unreadable), rig.state)
        assertTrue(rig.gateway.lookups.isEmpty())
        store.heal()
        rig.controller.reload()
        rig.answerLookup()
        assertTrue(rig.pay is PayPhase.Failed)
    }

    @Test
    fun `an unreadable slot is removed by sign-out too`() = runTest {
        val store = InMemoryPendingCheckoutStore()
        store.plantUnreadable(CK.codeA)
        val rig = CheckoutRig(this, store)

        signOut(rig)

        assertTrue(store.all().isEmpty())
    }

    @Test
    fun `hasSessionAttempts is true when a session attempt exists, for the sign-out confirmation`() = runTest {
        val payerRig = merchantAttempt(owner = AttemptOwner.Payer)
        assertFalse(payerRig.controller.hasSessionAttempts)
        val session = merchantAttempt(owner = CK.session(userOne))
        assertTrue(session.controller.hasSessionAttempts)
        session.store.fail(StoreOperation.List)
        assertTrue("storage that cannot be listed counts as yes: the safe answer is to ask", session.controller.hasSessionAttempts)
    }

    @Test
    fun `an expired session is not a sign-out, so a user who comes back finds the attempt`() = runTest {
        val rig = merchantAttempt(owner = CK.session(userOne))
        rig.controller.sessionDidChange(SessionChange.Ended)
        assertNotNull(rig.store.load(CK.codeA))
        assertTrue("and does not pull the screen away", rig.state.isOpen)
        assertEquals(FailureKind.Network, (rig.pay as PayPhase.Failed).kind)
    }
}
