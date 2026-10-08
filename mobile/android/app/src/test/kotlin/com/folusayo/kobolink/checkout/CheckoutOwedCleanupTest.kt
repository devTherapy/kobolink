package com.folusayo.kobolink.checkout

import com.folusayo.kobolink.auth.SessionChange
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A sign-out whose clearing failed is OWED, and what is owed is read before anything else a session event does. The
 * Kotlin port of iOS's `CheckoutOwedCleanupTests`, rule for rule. The obligation names (link code, idempotency key),
 * never a time, so there is no clock to set back; [the obligation names no time] pins that.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CheckoutOwedCleanupTest {

    /**
     * A (offline, session not yet confirmed) pays link L and the outcome is unknown; A signs out and the storage will
     * not remove the attempt, so the removal is owed.
     */
    private fun TestScope.stuckSignOut(): CheckoutRig {
        val rig = CheckoutRig(this, owner = CK.unconfirmed)
        rig.makeAttempt()
        rig.store.fail(StoreOperation.Remove)
        rig.controller.sessionDidChange(SessionChange.SignedOutByChoice)
        rig.settle()
        return rig
    }

    private fun openFreshLink(rig: CheckoutRig) {
        rig.controller.open(CK.codeA)
        rig.answerLookup()
    }

    @Test
    fun `relaunch, then B signs in BEFORE any link opens, A's attempt is removed, not adopted by B and shown to B`() = runTest {
        val first = stuckSignOut()
        assertEquals(1, first.store.snapshot.size)
        first.store.heal()
        val second = first.relaunched()

        second.controller.sessionDidChange(SessionChange.SignedIn(CK.userTwo))

        assertTrue(second.store.snapshot.isEmpty())
        openFreshLink(second)
        assertEquals(PayPhase.Idle, second.pay)
    }

    @Test
    fun `relaunch, then the check confirms B BEFORE any link opens, the same`() = runTest {
        val first = stuckSignOut()
        first.store.heal()
        val second = first.relaunched()

        second.controller.sessionDidChange(SessionChange.Resolved(CK.userTwo))

        assertTrue(second.store.snapshot.isEmpty())
        openFreshLink(second)
        assertEquals(PayPhase.Idle, second.pay)
    }

    @Test
    fun `B signs in in the SAME process while the removal still fails, A's attempt is not relabelled, and is hidden from B`() = runTest {
        val rig = stuckSignOut()

        rig.controller.sessionDidChange(SessionChange.SignedIn(CK.userTwo))

        assertEquals(CK.unconfirmed, rig.store.snapshot.single().owner)
        rig.controller.open(CK.codeA)
        assertEquals(CheckoutState.StorageBlocked(CK.codeA, StorageBlock.CannotClear), rig.state)
        assertEquals(1, rig.sends.size)
    }

    @Test
    fun `then a cold start confirms B while the removal STILL fails, still not relabelled, still hidden, and removed once it works`() = runTest {
        val first = stuckSignOut()
        first.controller.sessionDidChange(SessionChange.SignedIn(CK.userTwo))
        val second = first.relaunched()

        second.controller.sessionDidChange(SessionChange.Resolved(CK.userTwo))

        assertEquals(CK.unconfirmed, second.store.snapshot.single().owner)
        second.controller.open(CK.codeA)
        assertEquals(CheckoutState.StorageBlocked(CK.codeA, StorageBlock.CannotClear), second.state)
        first.store.heal()
        openFreshLink(second)
        assertTrue(second.store.snapshot.isEmpty())
        assertEquals(PayPhase.Idle, second.pay)
    }

    @Test
    fun `an unreadable slot the sign-out was to clear is not forgotten by the next session event`() = runTest {
        val store = InMemoryPendingCheckoutStore()
        store.plantUnreadable(CK.codeA)
        val first = CheckoutRig(this, store)
        store.fail(StoreOperation.Remove)
        first.controller.sessionDidChange(SessionChange.SignedOutByChoice)
        store.heal()
        val second = first.relaunched()

        second.controller.sessionDidChange(SessionChange.SignedIn(CK.userTwo))

        assertTrue(store.all().isEmpty())
    }

    @Test
    fun `the obligation names no time, so a leftover one cannot be fooled by the clock`() {
        assertEquals(setOf("code", "key"), fieldNames(SignOutObligation.Entry::class.java))
        assertEquals(setOf("entries"), fieldNames(SignOutObligation::class.java))
    }

    @Test
    fun `a later session's attempt is never removed by a cleanup still owed`() = runTest {
        val first = stuckSignOut()
        // C signs in and starts a payment on another link while A's removal is still owed.
        first.owner = CK.session(CK.userTwo)
        first.controller.sessionDidChange(SessionChange.SignedIn(CK.userTwo))
        first.makeAttempt(CK.codeB)
        val laterKey = first.store.snapshot.single { it.request.code == CK.codeB }.key

        // Storage recovers and the owed removal runs.
        first.store.heal()
        first.controller.open(CK.codeA)
        first.answerLookup()

        assertEquals(listOf(CK.codeB), first.store.snapshot.map { it.request.code })
        assertEquals(laterKey, first.store.snapshot.single().key)
    }

    // ---- a sign-out that cannot be made safe does not happen ----------------------------------------------------

    private fun TestScope.attemptRig(owner: AttemptOwner = CK.session(CK.userOne)): CheckoutRig {
        val rig = CheckoutRig(this, owner = owner)
        rig.makeAttempt()
        return rig
    }

    @Test
    fun `the sign-out is prepared, what it owes is written down by key BEFORE anything is removed`() = runTest {
        val rig = attemptRig()
        val key = rig.store.snapshot.single().key

        assertTrue(rig.controller.prepareSignOut())

        assertEquals(listOf(SignOutObligation.Entry(CK.codeA, key)), rig.store.obligation?.entries)
        assertEquals(1, rig.store.snapshot.size)
    }

    @Test
    fun `with nothing owed, the sign-out is safe and writes nothing`() = runTest {
        val rig = attemptRig(owner = AttemptOwner.Payer)

        assertTrue(rig.controller.prepareSignOut())

        assertNull(rig.store.obligation)
        assertTrue(CheckoutRig(this).controller.prepareSignOut())
    }

    @Test
    fun `if what it owes cannot be written down, the sign-out is NOT safe, it must not happen`() = runTest {
        val rig = attemptRig()
        rig.store.fail(StoreOperation.Obligation)

        assertFalse(rig.controller.prepareSignOut())

        assertNull(rig.store.obligation)
        assertEquals(1, rig.store.snapshot.size)
    }

    @Test
    fun `if the device's attempts cannot be listed, the sign-out is NOT safe`() = runTest {
        val rig = attemptRig()
        rig.store.fail(StoreOperation.List)

        assertFalse(rig.controller.prepareSignOut())
    }

    @Test
    fun `if an earlier obligation cannot be read, the sign-out is NOT safe`() = runTest {
        for (kind in StoreFailureKind.entries) {
            val store = InMemoryPendingCheckoutStore()
            store.save(CK.pending(CK.codeA, owner = CK.session(CK.userOne)))
            store.fail(StoreOperation.Obligation, kind)
            val coldStart = CheckoutRig(this, store)

            assertFalse("$kind", coldStart.controller.prepareSignOut())
        }
    }

    @Test
    fun `a sign-out that was not prepared still hides every session attempt, rather than showing it`() = runTest {
        val rig = attemptRig()
        rig.store.fail(StoreOperation.Obligation)

        rig.controller.sessionDidChange(SessionChange.SignedOutByChoice)
        rig.controller.open(CK.codeA)

        assertEquals(CheckoutState.StorageBlocked(CK.codeA, StorageBlock.CannotClear), rig.state)
    }

    // ---- no way out of a record that cannot be read -----------------------------------------------------------------

    @Test
    fun `an obligation this build cannot read blocks every link, offers a reset, and the reset forgets everything and opens the link`() = runTest {
        val store = InMemoryPendingCheckoutStore()
        store.save(CK.pending(CK.codeA, owner = AttemptOwner.Payer))
        store.save(CK.pending(CK.codeB, key = "persisted-key-B-0123456789", owner = CK.unconfirmed))
        store.fail(StoreOperation.Obligation, StoreFailureKind.Undecodable)
        val rig = CheckoutRig(this, store)

        rig.controller.open(CK.codeA)
        assertEquals(CheckoutState.StorageBlocked(CK.codeA, StorageBlock.ObligationUnreadable), rig.state)
        assertTrue(rig.gateway.lookups.isEmpty())

        // Storage still refuses to take the record back: the screen says so, and the link stays shut.
        rig.controller.resetCheckoutData()
        assertEquals(CheckoutState.StorageBlocked(CK.codeA, StorageBlock.ResetFailed), rig.state)
        assertTrue(rig.gateway.lookups.isEmpty())

        // It lets go: every slot and the record are gone, and the link opens as a fresh one.
        store.heal()
        rig.controller.resetCheckoutData()
        rig.answerLookup()
        assertEquals(PayPhase.Idle, rig.pay)
        assertTrue(store.snapshot.isEmpty())
        assertNull(store.obligation)
    }

    @Test
    fun `a record that merely cannot be reached right now has no reset, only Try again`() = runTest {
        val store = InMemoryPendingCheckoutStore()
        store.save(CK.pending(CK.codeA, owner = AttemptOwner.Payer))
        store.fail(StoreOperation.Obligation)
        val rig = CheckoutRig(this, store)

        rig.controller.open(CK.codeA)
        assertEquals(CheckoutState.StorageBlocked(CK.codeA, StorageBlock.Unreadable), rig.state)
        rig.controller.resetCheckoutData()

        assertEquals(1, store.snapshot.size)
        assertEquals(CheckoutState.StorageBlocked(CK.codeA, StorageBlock.Unreadable), rig.state)
    }

    @Test
    fun `the reset says what it forgets, and the blocked copy names it`() {
        assertTrue(RESET_MESSAGE.contains("If you already paid, check with the merchant first."))
        for (block in listOf(StorageBlock.ObligationUnreadable, StorageBlock.ResetFailed)) {
            val notice = storageBlockedNotice(block)
            assertEquals(STORAGE_BLOCKED_MONEY_LINE, notice.moneyLine)
            assertFalse(notice.moneyLine.contains("Nothing was sent"))
        }
        assertTrue(storageBlockedNotice(StorageBlock.ObligationUnreadable).nextStep.contains("Resetting checkout data"))
    }

    @Test
    fun `a different person who adopted an attempt is not told they started it`() {
        val interrupted = failureNoticeBody(FailureKind.Interrupted)
        val words = listOf(SIGN_OUT_WARNING, interrupted, startOverMessage(null, "M")).joinToString(" ")
        assertFalse(words.contains("you started"))
        assertFalse(words.contains("This payment was started"))
        assertTrue(SIGN_OUT_WARNING.startsWith("A payment on this phone was started and not finished."))
        assertTrue(SIGN_OUT_WARNING.contains("check with the merchant first"))
    }

    private fun failureNoticeBody(kind: FailureKind): String =
        attemptNotice(link(), PayPhase.Failed(kind, CK.request())).body
}
