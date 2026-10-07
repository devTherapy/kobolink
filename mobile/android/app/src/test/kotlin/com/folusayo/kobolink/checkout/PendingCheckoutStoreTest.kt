package com.folusayo.kobolink.checkout

import android.content.SharedPreferences
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A SharedPreferences stand-in whose map is the "disk": a new store over the same instance is a new process. */
class FakePrefs(var failCommits: Boolean = false) : SharedPreferences {
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

class PendingCheckoutStoreTest {

    private val request = InitializeRequest("7hK2mQ9x", 1_500_000, "Tunde Bello", "tunde@example.com")
    private val unknown = PendingCheckout(request, key = "attempt-key-0-0123456789")
    private val started = unknown.copy(reference = "kbl_abcdefghjk", confirmedAmountKobo = 1_500_000)

    @Test
    fun `the codec round-trips an unknown outcome and a started payment`() {
        assertEquals(unknown, PendingCheckoutCodec.decode(PendingCheckoutCodec.encode(unknown)))
        assertEquals(started, PendingCheckoutCodec.decode(PendingCheckoutCodec.encode(started)))
    }

    @Test
    fun `garbage on disk reads as nothing pending, not a crash`() {
        assertNull(PendingCheckoutCodec.decode("not json"))
        assertNull(PendingCheckoutCodec.decode("""{"key":"k"}"""))
        assertNull(PendingCheckoutCodec.decode("[]"))
    }

    @Test
    fun `a pending payment survives a new process, key included`() {
        val prefs = FakePrefs()
        EncryptedPendingCheckoutStore(prefs).save("payer", request.code, started)

        assertEquals(started, EncryptedPendingCheckoutStore(prefs).load("payer", request.code))
    }

    @Test
    fun `each owner and each link has its own slot`() {
        val store = EncryptedPendingCheckoutStore(FakePrefs())
        store.save("payer", "7hK2mQ9x", unknown)

        assertNull(store.load(ownerFor("u1"), "7hK2mQ9x"))
        assertNull(store.load("payer", "Zz3Yy4Xx"))
        store.save("payer", "Zz3Yy4Xx", started)
        assertEquals(unknown, store.load("payer", "7hK2mQ9x"))
    }

    @Test
    fun `saving null clears only that slot`() {
        val store = EncryptedPendingCheckoutStore(FakePrefs())
        store.save("payer", "7hK2mQ9x", unknown)
        store.save("payer", "Zz3Yy4Xx", unknown)
        store.save("payer", "7hK2mQ9x", null)

        assertNull(store.load("payer", "7hK2mQ9x"))
        assertEquals(unknown, store.load("payer", "Zz3Yy4Xx"))
    }

    @Test
    fun `clearing an owner removes all its links and nobody else's`() {
        val store = EncryptedPendingCheckoutStore(FakePrefs())
        val merchant = ownerFor("u1")
        store.save(merchant, "7hK2mQ9x", unknown)
        store.save(merchant, "Zz3Yy4Xx", unknown)
        store.save(ownerFor("u10"), "7hK2mQ9x", unknown) // an id that merely starts the same
        store.save("payer", "7hK2mQ9x", unknown)

        store.clearOwner(merchant)

        assertNull(store.load(merchant, "7hK2mQ9x"))
        assertNull(store.load(merchant, "Zz3Yy4Xx"))
        assertEquals(unknown, store.load(ownerFor("u10"), "7hK2mQ9x"))
        assertEquals(unknown, store.load("payer", "7hK2mQ9x"))
    }

    @Test
    fun `a write that does not reach disk is reported, never swallowed`() {
        val prefs = FakePrefs(failCommits = true)
        var thrown: Throwable? = null
        try {
            EncryptedPendingCheckoutStore(prefs).save("payer", request.code, unknown)
        } catch (e: IOException) {
            thrown = e
        }
        assertTrue(thrown != null)
        assertTrue(prefs.disk.isEmpty())
    }

    @Test
    fun `the secure-storage-unavailable store refuses to record, so nothing is sent`() {
        val store = UnavailablePendingCheckoutStore(IllegalStateException("keystore"))
        assertNull(store.load("payer", request.code))
        var thrown = false
        try {
            store.save("payer", request.code, unknown)
        } catch (e: IOException) {
            thrown = true
        }
        assertTrue(thrown)
        store.save("payer", request.code, null) // clearing is always allowed
    }

    @Test
    fun `the stored text holds the payment's details and nothing like a token`() {
        val prefs = FakePrefs()
        EncryptedPendingCheckoutStore(prefs).save("payer", request.code, unknown)
        val raw = prefs.disk.values.single()
        assertFalse(raw.contains("token", ignoreCase = true))
        assertTrue(raw.contains("attempt-key-0-0123456789"))
    }
}
