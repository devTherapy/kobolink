package com.folusayo.kobolink.auth

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Needs a real Android Keystore (`MasterKey`), so this runs on a device or
 * emulator (`connectedAndroidTest`), not the JVM unit-test sandbox — see
 * `AuthRepositoryTest`/`AuthInterceptorTest` for the parts of this feature
 * that ARE JVM-testable.
 *
 * Proves PLAN.md's M2 done-when directly against the actual bytes on disk:
 * (a) a saved token is never present in the backing XML file as plaintext,
 * and (b) [TokenStore.clear] genuinely removes it, not merely from this
 * process's in-memory view — a second, independent [EncryptedTokenStore]
 * instance over the same file confirms it stays gone.
 */
@RunWith(AndroidJUnit4::class)
class EncryptedTokenStoreInstrumentedTest {

    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    /** The literal name every plaintext `SharedPreferences` read/write of the token would use — the plaintext regression this whole feature exists to prevent. */
    private val plaintextKeyName = "session_token"
    private val fakeToken = "AAAA.this-looks-like-a-real-bearer-session-token.BBBB1234567890"

    private fun backingFile(): File =
        File(context.filesDir.parentFile, "shared_prefs/${EncryptedTokenStore.PREFS_FILE_NAME}.xml")

    @Test
    fun savedTokenIsNotPlaintextOnDisk() {
        backingFile().delete()
        val store = EncryptedTokenStore(context)

        store.saveToken(fakeToken)
        assertEquals(fakeToken, store.token())

        val file = backingFile()
        assertTrue("expected ${file.path} to exist after saveToken()", file.exists())

        val raw = file.readText()
        assertFalse(
            "the raw XML file must never contain the plaintext token",
            raw.contains(fakeToken),
        )
        assertFalse(
            "EncryptedSharedPreferences also encrypts preference KEYS — the literal key name must not appear either",
            raw.contains(plaintextKeyName),
        )

        store.clear()
    }

    @Test
    fun clearRemovesTheTokenPermanently() {
        backingFile().delete()
        val store = EncryptedTokenStore(context)
        store.saveToken(fakeToken)
        assertEquals(fakeToken, store.token())

        store.clear()

        assertNull("token() must return null immediately after clear()", store.token())

        // A fresh instance over the same backing file — not just this
        // object's in-memory state — must also see nothing. This is what
        // makes "logout" durable rather than a value this process merely
        // forgot until the next read.
        val reopened = EncryptedTokenStore(context)
        assertNull("clear() must persist — a new EncryptedTokenStore over the same file must not see the old token", reopened.token())

        val raw = backingFile().readText()
        assertFalse(
            "no trace of the cleared token should remain in the backing file",
            raw.contains(fakeToken),
        )
    }
}
