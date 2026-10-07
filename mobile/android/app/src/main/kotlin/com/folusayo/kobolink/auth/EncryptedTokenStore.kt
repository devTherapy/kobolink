package com.folusayo.kobolink.auth

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.IOException

/**
 * [TokenStore] backed by `androidx.security:security-crypto`'s
 * `EncryptedSharedPreferences` — the mobile bearer token
 * (`AuthResponse.token`, `apps/api/src/auth/auth.controller.ts`'s
 * `finishAuth`) is the one credential that proves who this device is signed
 * in as, so it is encrypted at rest with a key that itself never leaves the
 * Android Keystore (`MasterKey`, AES256-GCM). Both the preference *keys* and
 * *values* are encrypted (AES256_SIV / AES256_GCM) — even the on-disk XML
 * attribute name for the token is ciphertext, not the literal string
 * `"session_token"`.
 *
 * This is the ONLY place in the app allowed to construct a
 * `SharedPreferences` for session state. Reaching for plain
 * `context.getSharedPreferences(...)` for the token anywhere else is exactly
 * the regression PLAN.md's M2 done-when exists to prevent.
 *
 * `androidx.security:security-crypto`'s `EncryptedSharedPreferences`/
 * `MasterKey` are marked `@Deprecated` upstream (Google's guidance now
 * points at rolling your own Tink-based scheme), but 1.1.0 is still the
 * latest stable release of the library PLAN.md's M2 row names by name
 * ("EncryptedSharedPreferences") and there is no drop-in stable successor
 * artifact yet — hence the blanket suppression below rather than chasing a
 * moving target this feature doesn't otherwise need.
 */
@Suppress("DEPRECATION")
class EncryptedTokenStore(context: Context) : TokenStore {

    private val prefs: SharedPreferences = openEncryptedPrefs(context, PREFS_FILE_NAME)

    // commit(), not apply(): apply() returns before the write reaches disk and
    // reports no failure, so a process kill right after logout could resurrect
    // the session, and a failed save would look like a signed-in user.
    override fun saveToken(token: String) {
        // Never log `token` here or anywhere it passes through — see
        // ApiClientProvider's HttpLoggingInterceptor setup for the
        // corresponding rule on the wire.
        if (!prefs.edit().putString(KEY_TOKEN, token).commit()) {
            throw IOException("Secure storage did not accept the session token (SharedPreferences commit failed).")
        }
    }

    override fun token(): String? = prefs.getString(KEY_TOKEN, null)

    override fun clear() {
        if (!prefs.edit().remove(KEY_TOKEN).commit()) {
            throw IOException("Secure storage did not remove the session token (SharedPreferences commit failed).")
        }
    }

    companion object {
        /**
         * The backing XML file's name, under `/data/data/<package>/shared_prefs/`.
         * Its *contents* are ciphertext (see class doc) — this constant is not
         * a secret, it is just where to point a test (or `adb shell run-as`)
         * that wants to assert the on-disk bytes are not the plaintext token.
         */
        const val PREFS_FILE_NAME = "kobolink_secure_prefs"
        private const val KEY_TOKEN = "session_token"
    }
}

/**
 * The one way this app opens an `EncryptedSharedPreferences` file: AES256-GCM
 * values, AES256-SIV keys, a Keystore-held AES256-GCM master key. The session
 * token ([EncryptedTokenStore]) and the pending-payment record
 * ([com.folusayo.kobolink.wallet.EncryptedPendingAttemptStore]) both come
 * through here, so there is a single secure-storage recipe and no plain
 * `getSharedPreferences` for either.
 */
@Suppress("DEPRECATION")
fun openEncryptedPrefs(context: Context, fileName: String): SharedPreferences {
    val masterKey = MasterKey.Builder(context.applicationContext)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    return EncryptedSharedPreferences.create(
        context.applicationContext,
        fileName,
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
}
