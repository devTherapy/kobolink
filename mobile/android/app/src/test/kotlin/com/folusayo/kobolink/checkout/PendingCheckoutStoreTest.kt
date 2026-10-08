package com.folusayo.kobolink.checkout

import android.content.SharedPreferences
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A SharedPreferences stand-in whose map is the "disk": a new store over the same instance is a new process. */
class FakePrefs(var failCommits: Boolean = false, var failReads: Boolean = false) : SharedPreferences {
    val disk = HashMap<String, String>()

    override fun getAll(): MutableMap<String, *> {
        if (failReads) throw IllegalStateException("keystore")
        return disk
    }

    override fun getString(key: String?, defValue: String?): String? {
        if (failReads) throw IllegalStateException("keystore")
        return disk[key] ?: defValue
    }

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

    private fun stores(): List<PendingCheckoutStore> = listOf(EncryptedPendingCheckoutStore(FakePrefs()), InMemoryPendingCheckoutStore())

    private fun failure(block: () -> Unit): PendingStoreException? = try {
        block()
        null
    } catch (e: PendingStoreException) {
        e
    }

    @Test
    fun `the codec round-trips an unknown outcome, a started payment and every kind of owner`() {
        assertEquals(unknown, PendingCheckoutCodec.decode(PendingCheckoutCodec.encode(unknown)))
        assertEquals(started, PendingCheckoutCodec.decode(PendingCheckoutCodec.encode(started)))
        for (owner in listOf(AttemptOwner.Payer, AttemptOwner.Session(null), AttemptOwner.Session("u1"))) {
            val owned = started.copy(owner = owner)
            assertEquals(owned, PendingCheckoutCodec.decode(PendingCheckoutCodec.encode(owned)))
        }
    }

    @Test
    fun `anything this build cannot read decodes to null, never to a guess`() {
        assertNull(PendingCheckoutCodec.decode("not json"))
        assertNull(PendingCheckoutCodec.decode("""{"key":"k"}"""))
        assertNull(PendingCheckoutCodec.decode("[]"))
        // A version this build does not know, and an owner kind it does not know.
        val raw = PendingCheckoutCodec.encode(unknown)
        assertNull(PendingCheckoutCodec.decode(raw.replace("\"version\":1", "\"version\":2")))
        assertNull(PendingCheckoutCodec.decode(raw.replace("\"payer\"", "\"somebody\"")))
        assertNull(PendingCheckoutCodec.decodeObligation("""{"version":1}"""))
        assertNull(PendingCheckoutCodec.decodeObligation("""{"version":9,"entries":[]}"""))
    }

    @Test
    fun `the obligation round-trips, including an entry for an unreadable slot that has no key`() {
        val obligation = SignOutObligation(listOf(SignOutObligation.Entry("aaaaaaaa", "key-a"), SignOutObligation.Entry("bbbbbbbb", null)))
        assertEquals(obligation, PendingCheckoutCodec.decodeObligation(PendingCheckoutCodec.encodeObligation(obligation)))
        for (store in stores()) {
            assertNull(store.loadObligation())
            store.saveObligation(obligation)
            assertEquals(obligation, store.loadObligation())
            store.clearObligation()
            assertNull(store.loadObligation())
        }
    }

    @Test
    fun `a pending payment survives a new process, key included`() {
        val prefs = FakePrefs()
        EncryptedPendingCheckoutStore(prefs).save(started)

        assertEquals(started, EncryptedPendingCheckoutStore(prefs).load(request.code))
    }

    @Test
    fun `each link has its own slot, found whoever is signed in`() {
        for (store in stores()) {
            store.save(unknown.copy(owner = AttemptOwner.Session("u1")))

            assertNull(store.load("Zz3Yy4Xx"))
            store.save(started.copy(request = request.copy(code = "Zz3Yy4Xx")))
            assertEquals(unknown.copy(owner = AttemptOwner.Session("u1")), store.load("7hK2mQ9x"))
        }
    }

    @Test
    fun `removing clears only that slot, and removing nothing is not an error`() {
        for (store in stores()) {
            store.save(unknown)
            store.save(unknown.copy(request = request.copy(code = "Zz3Yy4Xx")))
            store.remove("7hK2mQ9x")
            store.remove("nothing-here")

            assertNull(store.load("7hK2mQ9x"))
            assertEquals("Zz3Yy4Xx", store.load("Zz3Yy4Xx")?.request?.code)
        }
    }

    @Test
    fun `all lists every slot, the pending ones decoded and the unreadable ones by id, and not the obligation`() {
        val prefs = FakePrefs()
        val store = EncryptedPendingCheckoutStore(prefs)
        store.save(unknown)
        store.saveObligation(SignOutObligation(emptyList()))
        prefs.disk["pending/zzzzzzzz"] = "garbage"

        assertEquals(
            listOf<PendingSlot>(PendingSlot.Pending(unknown), PendingSlot.Unreadable("zzzzzzzz")),
            store.all(),
        )
    }

    @Test
    fun `an unreadable slot is a failure with the undecodable kind, never nothing, and remove clears it`() {
        val prefs = FakePrefs()
        prefs.disk["pending/7hK2mQ9x"] = "not json"
        val store = EncryptedPendingCheckoutStore(prefs)

        assertEquals(StoreFailureKind.Undecodable, failure { store.load("7hK2mQ9x") }?.kind)

        store.remove("7hK2mQ9x")
        assertNull(store.load("7hK2mQ9x"))
    }

    @Test
    fun `an obligation this build cannot read is undecodable, not nothing owed`() {
        val prefs = FakePrefs()
        prefs.disk["signout-obligation"] = "garbage"

        assertEquals(StoreFailureKind.Undecodable, failure { EncryptedPendingCheckoutStore(prefs).loadObligation() }?.kind)
    }

    @Test
    fun `storage that cannot be reached is the unavailable kind on every read, never nothing`() {
        val prefs = FakePrefs(failReads = true)
        val store = EncryptedPendingCheckoutStore(prefs)

        assertEquals(StoreFailureKind.Unavailable, failure { store.load("7hK2mQ9x") }?.kind)
        assertEquals(StoreFailureKind.Unavailable, failure { store.all() }?.kind)
        assertEquals(StoreFailureKind.Unavailable, failure { store.loadObligation() }?.kind)
    }

    @Test
    fun `a write that does not reach disk is reported, never swallowed`() {
        val prefs = FakePrefs(failCommits = true)
        val store = EncryptedPendingCheckoutStore(prefs)
        val writes: Map<StoreOperation, () -> Unit> = mapOf(
            StoreOperation.Write to { store.save(unknown) },
            StoreOperation.Remove to { store.remove(request.code) },
            StoreOperation.Obligation to { store.saveObligation(SignOutObligation(emptyList())) },
        )
        for ((operation, write) in writes) {
            assertEquals("$operation", operation, failure(write)?.operation)
        }
        assertTrue(failure { store.clearObligation() } is PendingStoreException)
        assertTrue(prefs.disk.isEmpty())
    }

    @Test
    fun `the secure-storage-unavailable store holds nothing and accepts nothing, and says so on every call`() {
        val store = UnavailablePendingCheckoutStore(IllegalStateException("keystore"))
        val calls: List<() -> Unit> = listOf(
            { store.load(request.code) },
            { store.save(unknown) },
            { store.remove(request.code) },
            { store.all() },
            { store.loadObligation() },
            { store.saveObligation(SignOutObligation(emptyList())) },
            { store.clearObligation() },
        )
        for (call in calls) {
            assertEquals(StoreFailureKind.Unavailable, failure(call)?.kind)
        }
    }

    @Test
    fun `a store that could not be opened is tried again on the next call, not cached as unavailable for the life of the process`() {
        var attempts = 0
        val real = InMemoryPendingCheckoutStore()
        val store = ReopeningPendingCheckoutStore {
            attempts += 1
            if (attempts < 3) throw IllegalStateException("keystore not ready") else real
        }

        assertEquals(StoreFailureKind.Unavailable, failure { store.load(request.code) }?.kind)
        assertEquals(StoreFailureKind.Unavailable, failure { store.saveObligation(SignOutObligation(emptyList())) }?.kind)
        store.save(unknown) // the third try opens it
        assertEquals(unknown, store.load(request.code))
        assertEquals("once open it stays open", 3, attempts)
    }

    @Test
    fun `the in-memory store's failure switches are per operation and can be healed`() {
        val store = InMemoryPendingCheckoutStore()
        store.save(unknown)
        store.fail(StoreOperation.Read)
        assertEquals(StoreOperation.Read, failure { store.load(request.code) }?.operation)
        store.save(unknown) // writes are not failing
        store.heal()
        assertEquals(unknown, store.load(request.code))
    }

    @Test
    fun `the stored text holds the payment's details and nothing like a token`() {
        val prefs = FakePrefs()
        EncryptedPendingCheckoutStore(prefs).save(unknown)
        val raw = prefs.disk.values.single()
        assertFalse(raw.contains("token", ignoreCase = true))
        assertTrue(raw.contains("attempt-key-0-0123456789"))
    }

    @Test(expected = IOException::class)
    fun `a store failure is an IOException, so a caller that only cares that it failed can catch that`() {
        UnavailablePendingCheckoutStore().save(unknown)
    }
}
