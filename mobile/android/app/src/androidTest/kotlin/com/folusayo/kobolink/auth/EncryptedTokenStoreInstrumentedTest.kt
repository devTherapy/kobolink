package com.folusayo.kobolink.auth

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Needs a real Android Keystore (`MasterKey`), so this runs on a device or
 * emulator (`connectedAndroidTest`), not the JVM unit-test sandbox — see
 * `AuthRepositoryTest`/`AuthInterceptorTest`/`SessionControllerTest` for the
 * parts of this feature that ARE JVM-testable. NOTE: written without an
 * emulator available; it compiles (`compileDebugAndroidTestKotlin`) but has
 * not been run.
 *
 * Proves PLAN.md's M2 done-when against the bytes on disk, never against the
 * in-process `SharedPreferences` object:
 *
 * `Context` caches one `SharedPreferences` instance per file, so any check
 * that goes through `store.token()` or a second `EncryptedTokenStore` is
 * answered from that cache and passes even if nothing was ever written. Every
 * durability assertion here therefore reads the backing XML file directly.
 * That is only meaningful because [EncryptedTokenStore] saves and clears with
 * `commit()`, which returns after the write has reached disk (`apply()`
 * returns first and writes later, so a raw read could race it).
 */
@RunWith(AndroidJUnit4::class)
class EncryptedTokenStoreInstrumentedTest {

    private val context: Context = ApplicationProvider.getApplicationContext()

    private val fakeToken = "AAAA.this-looks-like-a-real-bearer-session-token.BBBB1234567890"

    /** The literal name a plaintext `SharedPreferences` write of the token would use. */
    private val plaintextKeyName = "session_token"

    private val controlPrefsName = "kobolink_plaintext_control"

    @Before
    fun cleanSlate() = deleteAll()

    @After
    fun tearDown() = deleteAll()

    // deleteSharedPreferences also evicts the Context's cached instance, so each
    // test starts from a genuinely empty file rather than a stale cached map.
    private fun deleteAll() {
        context.deleteSharedPreferences(EncryptedTokenStore.PREFS_FILE_NAME)
        context.deleteSharedPreferences(controlPrefsName)
    }

    private fun prefsFile(name: String): File =
        File(context.applicationInfo.dataDir, "shared_prefs/$name.xml")

    private fun rawBytes(name: String): ByteArray {
        val file = prefsFile(name)
        assertTrue("expected ${file.path} to exist on disk", file.exists())
        return file.readBytes()
    }

    /** Byte-for-byte search, so a match cannot be missed to charset decoding. */
    private fun ByteArray.contains(needle: String): Boolean {
        val n = needle.toByteArray(Charsets.UTF_8)
        if (n.isEmpty() || n.size > size) return false
        for (i in 0..size - n.size) {
            var j = 0
            while (j < n.size && this[i + j] == n[j]) j++
            if (j == n.size) return true
        }
        return false
    }

    /** The `name="..."` attribute of every entry in a SharedPreferences XML file. */
    private fun entryNames(xml: ByteArray): Set<String> =
        Regex("""name="([^"]*)"""").findAll(String(xml, Charsets.UTF_8)).map { it.groupValues[1] }.toSet()

    @Test
    fun detectorControl_aPlainSharedPreferencesTokenIsFoundInTheRawFile() {
        // Proves the byte search in the next test CAN fail: the same check on a
        // deliberately plaintext store must find the token and the key name.
        val committed = context.getSharedPreferences(controlPrefsName, Context.MODE_PRIVATE)
            .edit().putString(plaintextKeyName, fakeToken).commit()
        assertTrue(committed)

        val raw = rawBytes(controlPrefsName)

        assertTrue("control: plaintext token must be visible in the raw file", raw.contains(fakeToken))
        assertTrue("control: plaintext key name must be visible in the raw file", raw.contains(plaintextKeyName))
    }

    @Test
    fun savedTokenIsNotPlaintextOnDisk() {
        val store = EncryptedTokenStore(context)

        store.saveToken(fakeToken) // synchronous: on disk when this returns

        val raw = rawBytes(EncryptedTokenStore.PREFS_FILE_NAME)
        assertTrue("the file must actually contain the encrypted entry", raw.isNotEmpty())
        assertFalse("the raw file must never contain the plaintext token", raw.contains(fakeToken))
        assertFalse(
            "EncryptedSharedPreferences also encrypts preference KEYS, so the literal key name must not appear",
            raw.contains(plaintextKeyName),
        )
    }

    @Test
    fun saveWritesAnEntryAndClearRemovesItFromDisk() {
        val store = EncryptedTokenStore(context)
        val baseline = entryNames(rawBytes(EncryptedTokenStore.PREFS_FILE_NAME)) // just the key/value keysets

        store.saveToken(fakeToken)
        val afterSave = entryNames(rawBytes(EncryptedTokenStore.PREFS_FILE_NAME))
        assertEquals("save must add exactly one entry on disk", baseline.size + 1, afterSave.size)
        assertTrue(afterSave.containsAll(baseline))

        store.clear()

        // Read from the file, not from store.token(): the cached in-process
        // instance would report null here even if the removal never reached disk.
        val afterClear = entryNames(rawBytes(EncryptedTokenStore.PREFS_FILE_NAME))
        assertEquals("clear() must leave no token entry on disk", baseline, afterClear)
        assertFalse(rawBytes(EncryptedTokenStore.PREFS_FILE_NAME).contains(fakeToken))
        assertNull(store.token())
    }
}
