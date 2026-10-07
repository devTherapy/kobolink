package com.folusayo.kobolink.wallet

import android.content.SharedPreferences
import com.folusayo.kobolink.api.ApiClientProvider
import com.folusayo.kobolink.generated.api.models.TransferResponse
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A SharedPreferences stand-in whose map is the "disk": a new store over the same instance is a new process. */
private class FakePrefs(var failCommits: Boolean = false) : SharedPreferences {
    val disk = HashMap<String, String>()

    override fun getAll(): MutableMap<String, *> = disk
    override fun getString(key: String?, defValue: String?) = disk[key] ?: defValue
    override fun contains(key: String?) = disk.containsKey(key)
    override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
        private val puts = HashMap<String, String>()
        private val removes = HashSet<String>()
        override fun putString(key: String, value: String?) = apply { if (value == null) removes += key else puts[key] = value }
        override fun remove(key: String) = apply { removes += key }
        override fun commit(): Boolean {
            if (failCommits) return false
            removes.forEach { disk.remove(it) }
            disk.putAll(puts)
            return true
        }
        override fun apply() { commit() }
        override fun clear() = apply { disk.clear() }
        override fun putStringSet(key: String, values: MutableSet<String>?) = this
        override fun putInt(key: String, value: Int) = this
        override fun putLong(key: String, value: Long) = this
        override fun putFloat(key: String, value: Float) = this
        override fun putBoolean(key: String, value: Boolean) = this
    }
    override fun getStringSet(key: String?, defValues: MutableSet<String>?) = defValues
    override fun getInt(key: String?, defValue: Int) = defValue
    override fun getLong(key: String?, defValue: Long) = defValue
    override fun getFloat(key: String?, defValue: Float) = defValue
    override fun getBoolean(key: String?, defValue: Boolean) = defValue
    override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
    override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
}

class PendingAttemptStoreTest {

    private val attempt = TransferAttempt("key-0123456789abcdef", "+2348031234567", 250_000L, "rent", "Ada Obi")

    @Test
    fun `the codec round-trips every field, including absent optionals`() {
        assertEquals(attempt, PendingAttemptCodec.decode(PendingAttemptCodec.encode(attempt)))
        val bare = attempt.copy(note = null, payeeName = null)
        assertEquals(bare, PendingAttemptCodec.decode(PendingAttemptCodec.encode(bare)))
    }

    @Test
    fun `garbage on disk reads as nothing pending, not a crash`() {
        assertNull(PendingAttemptCodec.decode("not json"))
        assertNull(PendingAttemptCodec.decode("""{"key":"k"}"""))
        assertNull(PendingAttemptCodec.decode("[]"))
    }

    @Test
    fun `an attempt survives a new process, key included`() {
        val prefs = FakePrefs()
        EncryptedPendingAttemptStore(prefs).save("u1", attempt)

        assertEquals(attempt, EncryptedPendingAttemptStore(prefs).load("u1"))
    }

    @Test
    fun `each user has their own slot`() {
        val prefs = FakePrefs()
        val store = EncryptedPendingAttemptStore(prefs)
        store.save("u1", attempt)

        assertNull(store.load("u2"))
        store.save("u2", attempt.copy(key = "key-fedcba9876543210"))
        assertEquals(attempt, store.load("u1"))
    }

    @Test
    fun `saving null clears only that user`() {
        val prefs = FakePrefs()
        val store = EncryptedPendingAttemptStore(prefs)
        store.save("u1", attempt)
        store.save("u2", attempt)
        store.save("u1", null)

        assertNull(store.load("u1"))
        assertEquals(attempt, store.load("u2"))
    }

    @Test
    fun `a write that does not reach disk is reported, never swallowed`() {
        val prefs = FakePrefs(failCommits = true)
        var thrown: Throwable? = null
        try {
            EncryptedPendingAttemptStore(prefs).save("u1", attempt)
        } catch (e: IOException) {
            thrown = e
        }
        assertTrue(thrown != null)
        assertTrue(prefs.disk.isEmpty())
    }

    @Test
    fun `the secure-storage-unavailable store refuses to record, so nothing is sent`() {
        val store = UnavailablePendingAttemptStore(IllegalStateException("keystore"))
        assertNull(store.load("u1"))
        var thrown = false
        try {
            store.save("u1", attempt)
        } catch (e: IOException) {
            thrown = true
        }
        assertTrue(thrown)
        store.save("u1", null) // clearing is always allowed
    }

    @Test
    fun `the stored text holds the payment's details and nothing like a token`() {
        val prefs = FakePrefs()
        EncryptedPendingAttemptStore(prefs).save("u1", attempt)
        val raw = prefs.disk.values.single()
        assertFalse(raw.contains("token", ignoreCase = true))
        assertTrue(raw.contains("key-0123456789abcdef"))
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
