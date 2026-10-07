package com.folusayo.kobolink.wallet

import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class WalletHomeTest {

    private fun kotlinx.coroutines.test.TestScope.home(gateway: FakeGateway) = WalletHome(gateway, kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.test.UnconfinedTestDispatcher(testScheduler)))

    @Test
    fun `refresh loads the derived balance and the first page`() = runTest {
        val gateway = FakeGateway()
        gateway.walletResults += Result.success(wallet(3_000_000_000L))
        gateway.pageResults += Result.success(page(entry("p_2", -5_000), entry("p_1", 9_000), next = "c1"))
        val home = home(gateway)

        home.refresh()
        advanceUntilIdle()

        val state = home.state.value
        assertEquals(3_000_000_000L, state.wallet!!.balanceKobo)
        assertEquals(listOf("p_2", "p_1"), state.items.map { it.postingId })
        assertEquals("c1", state.nextCursor)
        assertTrue(state.loadedOnce)
        assertFalse(state.refreshing)
    }

    @Test
    fun `a failed refresh keeps what was loaded and says why`() = runTest {
        val gateway = FakeGateway()
        gateway.walletResults += Result.success(wallet(100_000))
        gateway.pageResults += Result.success(page(entry("p_1", 100_000)))
        gateway.walletResults += Result.failure(WalletReadException("Couldn't reach Kobolink to load your wallet."))
        gateway.pageResults += Result.failure(WalletReadException("Couldn't reach Kobolink to load your recent activity."))
        val home = home(gateway)

        home.refresh()
        advanceUntilIdle()
        home.refresh()
        advanceUntilIdle()

        val state = home.state.value
        assertEquals("the last balance stays on screen", 100_000L, state.wallet!!.balanceKobo)
        assertEquals(1, state.items.size)
        assertEquals("Couldn't reach Kobolink to load your wallet.", state.walletError)
        assertEquals("Couldn't reach Kobolink to load your recent activity.", state.activityError)
        assertTrue(state.loadedOnce)
    }

    @Test
    fun `a first refresh that fails is loaded-once with nothing to show`() = runTest {
        val gateway = FakeGateway()
        val home = home(gateway)

        home.refresh()
        advanceUntilIdle()

        val state = home.state.value
        assertNull(state.wallet)
        assertTrue(state.loadedOnce)
        assertTrue(state.walletError != null && state.activityError != null)
    }

    @Test
    fun `refresh while refreshing does nothing`() = runTest {
        val gateway = FakeGateway()
        gateway.walletResults += Result.success(wallet(1))
        gateway.pageResults += Result.success(page())
        gateway.readGate = kotlinx.coroutines.CompletableDeferred()
        val home = home(gateway)

        home.refresh()
        home.refresh()
        home.refresh()
        gateway.readGate!!.complete(Unit)
        advanceUntilIdle()

        assertEquals(1, gateway.walletCalls)
    }

    @Test
    fun `loading more appends the next page without duplicates`() = runTest {
        val gateway = FakeGateway()
        gateway.walletResults += Result.success(wallet(1))
        gateway.pageResults += Result.success(page(entry("p_3", 1), entry("p_2", 1), next = "c1"))
        gateway.pageResults += Result.success(page(entry("p_2", 1), entry("p_1", 1), next = null))
        val home = home(gateway)
        home.refresh()
        advanceUntilIdle()

        home.loadMore()
        advanceUntilIdle()

        assertEquals(listOf(null, "c1"), gateway.pageCursors)
        assertEquals(listOf("p_3", "p_2", "p_1"), home.state.value.items.map { it.postingId })
        assertNull(home.state.value.nextCursor)
    }

    @Test
    fun `a successful transfer updates balance and activity from the reply, without a refetch`() = runTest {
        val gateway = FakeGateway()
        gateway.walletResults += Result.success(wallet(1_000_000))
        gateway.pageResults += Result.success(page(entry("p_1", 1_000_000, "Funding")))
        val home = home(gateway)
        home.refresh()
        advanceUntilIdle()

        home.applyTransfer(transferResponse("p_2", 250_000, 750_000))

        val state = home.state.value
        assertEquals(750_000L, state.wallet!!.balanceKobo)
        assertEquals(listOf("p_2", "p_1"), state.items.map { it.postingId })
        assertEquals(-250_000L, state.items.first().amountKobo)
        assertEquals("no extra wallet fetch was needed", 1, gateway.walletCalls)
    }

    @Test
    fun `a read that started before a transfer cannot overwrite the new balance`() = runTest {
        val gateway = FakeGateway()
        gateway.walletResults += Result.success(wallet(1_000_000))      // the stale, pre-transfer read
        gateway.pageResults += Result.success(page())
        gateway.walletResults += Result.success(wallet(750_000))        // the read it is redone with
        gateway.pageResults += Result.success(page(entry("p_2", -250_000)))
        gateway.readGate = kotlinx.coroutines.CompletableDeferred()
        val home = home(gateway)

        home.refresh()
        home.applyTransfer(transferResponse("p_2", 250_000, 750_000))   // lands while the read is in flight
        gateway.readGate!!.complete(Unit)
        advanceUntilIdle()

        assertEquals(750_000L, home.state.value.wallet!!.balanceKobo)
        assertEquals(2, gateway.walletCalls)
    }

    @Test
    fun `clearing on sign-out drops the previous user's data, even from a read still in flight`() = runTest {
        val gateway = FakeGateway()
        gateway.walletResults += Result.success(wallet(5_000_000))
        gateway.pageResults += Result.success(page(entry("p_1", 5_000_000)))
        gateway.readGate = kotlinx.coroutines.CompletableDeferred()
        val home = home(gateway)

        home.refresh()
        home.clear()
        gateway.readGate!!.complete(Unit)
        advanceUntilIdle()

        val state = home.state.value
        assertNull("a late reply must not repopulate a signed-out wallet", state.wallet)
        assertTrue(state.items.isEmpty())
        assertFalse(state.loadedOnce)
    }

    @Test
    fun `a replayed transfer's older balance does not overwrite a newer one`() = runTest {
        val gateway = FakeGateway()
        val later = at.plusMinutes(5)
        gateway.walletResults += Result.success(wallet(600_000, asOf = later))
        gateway.pageResults += Result.success(page())
        val home = home(gateway)
        home.refresh()
        advanceUntilIdle()

        // Try again after an unknown outcome returns the ORIGINAL reply, stamped when it was first posted.
        home.applyTransfer(transferResponse("p_2", 250_000, newBalanceKobo = 750_000, asOf = at))

        assertEquals(600_000L, home.state.value.wallet!!.balanceKobo)
        assertEquals("the transaction itself is still shown", listOf("p_2"), home.state.value.items.map { it.postingId })
    }

    @Test
    fun `a newer balance from a transfer reply does replace the held one`() = runTest {
        val gateway = FakeGateway()
        gateway.walletResults += Result.success(wallet(1_000_000, asOf = at))
        gateway.pageResults += Result.success(page())
        val home = home(gateway)
        home.refresh()
        advanceUntilIdle()

        home.applyTransfer(transferResponse("p_2", 250_000, newBalanceKobo = 750_000, asOf = at.plusSeconds(1)))

        assertEquals(750_000L, home.state.value.wallet!!.balanceKobo)
    }

    @Test
    fun `a page that arrives after a refresh is dropped, not appended to the new list`() = runTest {
        val gateway = FakeGateway()
        gateway.walletResults += Result.success(wallet(1))
        gateway.pageResults += Result.success(page(entry("p_3", 1), entry("p_2", 1), next = "c1"))
        val home = home(gateway)
        home.refresh()
        advanceUntilIdle()

        gateway.pageGate = kotlinx.coroutines.CompletableDeferred()
        gateway.pageResults += Result.success(page(entry("p_1", 1), next = "stale-cursor")) // load more, held open
        home.loadMore()
        gateway.walletResults += Result.success(wallet(2))
        gateway.pageResults += Result.success(page(entry("p_9", 1), entry("p_3", 1), next = "c9")) // the refresh
        home.refresh()
        advanceUntilIdle()
        gateway.pageGate!!.complete(Unit)
        advanceUntilIdle()

        val state = home.state.value
        assertEquals(listOf("p_9", "p_3"), state.items.map { it.postingId })
        assertEquals("c9", state.nextCursor)
        assertFalse(state.loadingMore)
    }
}
