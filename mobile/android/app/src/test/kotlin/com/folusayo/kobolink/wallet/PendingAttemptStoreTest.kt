package com.folusayo.kobolink.wallet

import androidx.lifecycle.SavedStateHandle
import com.folusayo.kobolink.api.ApiClientProvider
import com.folusayo.kobolink.generated.api.models.TransferResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PendingAttemptStoreTest {

    private val attempt = TransferAttempt("key-0123456789abcdef", "+2348031234567", 250_000L, "rent", "Ada Obi")

    @Test
    fun `an attempt survives a round trip through saved state, key included`() {
        val handle = SavedStateHandle()
        SavedStatePendingAttemptStore(handle).save(attempt)

        // A new process: a new store over the restored handle.
        assertEquals(attempt, SavedStatePendingAttemptStore(handle).load())
    }

    @Test
    fun `optional parts may be absent`() {
        val bare = attempt.copy(note = null, payeeName = null)
        val handle = SavedStateHandle()
        SavedStatePendingAttemptStore(handle).save(bare)
        assertEquals(bare, SavedStatePendingAttemptStore(handle).load())
    }

    @Test
    fun `saving null clears it`() {
        val handle = SavedStateHandle()
        val store = SavedStatePendingAttemptStore(handle)
        store.save(attempt)
        store.save(null)
        assertNull(store.load())
        assertNull(SavedStatePendingAttemptStore(handle).load())
    }

    @Test
    fun `an empty handle has nothing pending`() {
        assertNull(SavedStatePendingAttemptStore(SavedStateHandle()).load())
    }

    @Test
    fun `the wallet's request Json still reads every response the generated one does`() {
        val body = """{"transaction":{"postingId":"p_1","kind":"transfer","amountKobo":-5000000,"counterparty":null,
              "note":null,"createdAt":"2026-10-07T10:00:00Z"},
              "wallet":{"accountId":"acc_1","currency":"NGN","balanceKobo":9007199254740991,"asOf":"2026-10-07T10:00:00Z"}}"""
        val viaWallet = ApiClientProvider.walletJson.decodeFromString(TransferResponse.serializer(), body)
        val viaGenerated = ApiClientProvider.json.decodeFromString(TransferResponse.serializer(), body)
        assertEquals(viaGenerated, viaWallet)
    }
}
