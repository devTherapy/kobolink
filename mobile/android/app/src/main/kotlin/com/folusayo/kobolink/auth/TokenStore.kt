package com.folusayo.kobolink.auth

/**
 * The one seam between "how a session token is stored" and everything else
 * that needs one — [AuthInterceptor] reads it on every request, [AuthRepository]
 * writes it after a successful login and clears it on logout. The only
 * production implementation is [EncryptedTokenStore]; a test fake can
 * implement this without touching the Android Keystore.
 *
 * PLAN.md's M2 row, done-when: "Token stored in Keychain /
 * EncryptedSharedPreferences, never in plain storage." Nothing in this
 * codebase is allowed to read or write the session token through any other
 * path (plain `SharedPreferences`, a file, a log line) — this interface is
 * the only door.
 */
interface TokenStore {
    /** Persists [token] as the current session credential, replacing any previous one. */
    fun saveToken(token: String)

    /** The current session token, or `null` if nothing is stored (signed out). */
    fun token(): String?

    /** Removes the stored token. After this call, [token] returns `null`. */
    fun clear()
}
