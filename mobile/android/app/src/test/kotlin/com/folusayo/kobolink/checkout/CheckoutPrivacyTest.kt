package com.folusayo.kobolink.checkout

import com.folusayo.kobolink.auth.SessionChange
import com.folusayo.kobolink.money.Kobo
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A stored payer's name and e-mail never reach a screen: the Kotlin port of iOS's `CheckoutPrivacyTests`. A remembered
 * attempt holds them (they are part of the request its idempotency key is bound to) and sends them again in a same-key
 * retry, but the person looking at the phone may not be the person who made the attempt, so no screen shows them and
 * no form is refilled with them.
 *
 * "A screen" is what the composables are built from: [attemptNotice], the started payment's words,
 * [storageBlockedNotice], and the form fields. The composables take their strings from these and from nothing else.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CheckoutPrivacyTest {

    private val name = payer.name
    private val email = payer.email

    /** Everything a person can read in the current state of [rig], built the way the screen builds it. */
    private fun shown(rig: CheckoutRig): String {
        val parts = mutableListOf(rig.form.name, rig.form.email, rig.form.amountText)
        when (val state = rig.state) {
            is CheckoutState.Loaded -> when (val pay = state.pay) {
                is PayPhase.Started -> parts += listOf(
                    pay.reference,
                    Kobo.formatNaira(pay.amountKobo),
                    startOverMessage(pay.reference, state.link.merchantName),
                )
                is PayPhase.Failed -> if (pay.isRemembered) parts += attemptNotice(state.link, pay).toString()
                is PayPhase.Retrying -> parts += attemptNotice(state.link, pay).toString()
                else -> Unit
            }
            is CheckoutState.StorageBlocked -> parts += storageBlockedNotice(state.block).toString()
            else -> Unit
        }
        return parts.joinToString(" | ")
    }

    private fun assertNoPayerDetails(rig: CheckoutRig, label: String) {
        val text = shown(rig)
        assertFalse("$label shows the payer's name", text.contains("Tunde") || text.contains("Bello"))
        assertFalse("$label shows the payer's e-mail", text.contains("tunde@example.com"))
    }

    @Test
    fun `started, interrupted, sending and blocked screens carry no name or email, and the form is empty after every way back`() = runTest {
        val rig = CheckoutRig(this)
        rig.openPayable()
        rig.fillForm()
        rig.pay() // in flight; never answered
        rig.controller.close() // Back
        assertNoPayerDetails(rig, "back")
        assertTrue(rig.form.isEmpty)

        rig.controller.open(CK.codeA)
        rig.answerLookup()
        assertTrue(rig.pay is PayPhase.Failed)
        assertNoPayerDetails(rig, "interrupted")

        rig.controller.retry()
        rig.settle()
        assertTrue(rig.pay is PayPhase.Retrying)
        assertNoPayerDetails(rig, "sending")

        rig.answerSend(InitializeOutcome.Failed(FailureKind.Network))
        assertTrue("a resent attempt is still shown as an attempt", (rig.pay as PayPhase.Failed).isRemembered)
        assertNoPayerDetails(rig, "unsettled")

        rig.controller.retry()
        rig.answerSend(InitializeOutcome.Started(CK.reference, 1_500_000))
        assertNoPayerDetails(rig, "started")

        // A relaunch, and every way to a new form.
        val cold = rig.relaunched()
        cold.controller.open(CK.codeA)
        cold.answerLookup()
        assertTrue(cold.pay is PayPhase.Started)
        assertNoPayerDetails(cold, "cold start")

        cold.controller.startOver()
        cold.answerLookup()
        assertEquals(PayPhase.Idle, cold.pay)
        assertTrue("Start a new payment opens an EMPTY form", cold.form.isEmpty)
        assertTrue(cold.store.snapshot.isEmpty())
        assertNoPayerDetails(cold, "start over")

        val blocked = CheckoutRig(this)
        blocked.store.fail(StoreOperation.Read)
        blocked.controller.open(CK.codeA)
        assertNoPayerDetails(blocked, "blocked")
    }

    @Test
    fun `a restored attempt never refills the form, and the same-key retry still carries the stored details`() = runTest {
        val first = CheckoutRig(this)
        first.makeAttempt()
        first.finish()

        val second = first.relaunched()
        second.controller.open(CK.codeA)
        second.answerLookup()

        assertTrue("the form stays empty for a remembered attempt", second.form.isEmpty)
        assertTrue(second.pay is PayPhase.Failed)

        second.controller.retry()
        second.settle()

        assertEquals("the retry is sent from the stored attempt, not from the form", CK.request(name = name, email = email), second.sends.single().first)
        assertEquals("under the stored key", "run1-key-0-0123456789", second.sends.single().second)
        assertTrue(second.form.isEmpty)
    }

    @Test
    fun `an attempt another user made is not shown to a user who is confirmed, and its details are gone from the store`() = runTest {
        val first = CheckoutRig(this, owner = CK.session(CK.userOne))
        first.makeAttempt()
        first.finish()

        val second = first.relaunched(owner = CK.unconfirmed)
        second.controller.sessionDidChange(SessionChange.Resolved(CK.userTwo))
        second.controller.open(CK.codeA)
        second.answerLookup()

        assertEquals(PayPhase.Idle, second.pay)
        assertTrue(second.store.snapshot.isEmpty())
        assertNoPayerDetails(second, "the next user")
    }

    @Test
    fun `the types a screen is made of have no place for a name or an email`() {
        val fields = fieldNames(AttemptNotice::class.java)
        assertEquals(setOf("heading", "body", "amountLine", "spokenAmountLine", "moneyLine", "nextStep"), fields)
        assertEquals(setOf("amountKobo"), fieldNames(PayPhase.Retrying::class.java))
        assertEquals(setOf("reference", "amountKobo", "startOverFailed"), fieldNames(PayPhase.Started::class.java))
    }
}

/** Storage that cannot be cleared, and the words about it. Ported from iOS's `CheckoutBlockedStorageTests`. */
@OptIn(ExperimentalCoroutinesApi::class)
class CheckoutBlockedStorageTest {

    @Test
    fun `Start a new payment on an unreadable record that cannot be removed says so, and changes nothing`() = runTest {
        val rig = CheckoutRig(this)
        rig.store.plantUnreadable(CK.codeA)
        rig.controller.open(CK.codeA)
        assertEquals(CheckoutState.StorageBlocked(CK.codeA, StorageBlock.Undecodable), rig.state)

        rig.store.fail(StoreOperation.Remove)
        rig.controller.startOver()
        assertEquals(CheckoutState.StorageBlocked(CK.codeA, StorageBlock.UndecodableClearFailed), rig.state)
        assertTrue(rig.gateway.lookups.isEmpty())

        // It still works once storage does.
        rig.store.heal()
        rig.controller.startOver()
        rig.answerLookup()
        assertEquals(PayPhase.Idle, rig.pay)
        assertTrue(rig.store.all().isEmpty())
    }

    @Test
    fun `a record that may already have been sent is never described as nothing having been sent`() {
        for (block in StorageBlock.entries) {
            val notice = storageBlockedNotice(block)
            val words = listOf(notice.heading, notice.body ?: "", notice.moneyLine, notice.nextStep).joinToString(" ")
            assertFalse("$block", words.contains("Nothing was sent"))
            assertFalse("$block", words.lowercase().contains("no money"))
            assertEquals("$block", "A payment may already have been started on this link.", notice.moneyLine)
            assertTrue("$block", words.lowercase().contains("check with the merchant before paying again"))
        }
    }

    @Test
    fun `a storage read that fails is a blocked link, not an empty one`() = runTest {
        val rig = CheckoutRig(this)
        rig.store.save(CK.pending(CK.codeA))
        rig.store.fail(StoreOperation.Read)

        rig.controller.open(CK.codeA)

        assertEquals(CheckoutState.StorageBlocked(CK.codeA, StorageBlock.Unreadable), rig.state)
        assertTrue("and nothing was looked up or paid", rig.gateway.lookups.isEmpty() && rig.sends.isEmpty())
    }
}
