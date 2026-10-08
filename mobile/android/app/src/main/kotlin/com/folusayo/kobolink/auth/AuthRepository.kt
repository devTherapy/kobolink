package com.folusayo.kobolink.auth

import com.folusayo.kobolink.generated.api.apis.AuthApi
import com.folusayo.kobolink.generated.api.models.ApiError
import com.folusayo.kobolink.generated.api.models.AuthResponseUser
import com.folusayo.kobolink.generated.api.models.LoginRequest
import com.folusayo.kobolink.generated.api.models.MeResponseUser
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/**
 * The one place that turns `AuthApi` calls into a signed-in/signed-out state
 * change. Every branch that can end in "we are now signed in" writes the
 * token through [tokenStore] (never anywhere else); every branch that ends
 * in "we are now signed out" clears it the same way.
 *
 * Every failure is an [AuthException], so callers can tell a definitive
 * server rejection (401) from "couldn't find out" (no network, 5xx).
 */
class AuthRepository(
    private val authApi: AuthApi,
    private val tokenStore: TokenStore,
    private val json: Json,
    /**
     * Tells the server to end the session behind [token], which has ALREADY been removed from [tokenStore] (so the
     * ordinary request path, which attaches the stored token, cannot carry it). Null falls back to [AuthApi.logout],
     * which sends whatever token is stored at that moment: nothing, by then. See [SessionRevoker].
     */
    private val revoke: (suspend (token: String) -> Unit)? = null,
) {
    /** Whether a session token is currently stored — does not confirm the server still honors it; see [currentUser]. */
    val isSignedIn: Boolean
        get() = tokenStore.token() != null

    /**
     * `POST /api/auth/login` with `client: "mobile"` — the only request in
     * this app that receives `AuthResponse.token` in the body instead of an
     * httpOnly cookie (`auth.controller.ts`'s `finishAuth`). On success the
     * token is written to [tokenStore] before this function returns, so a
     * caller never has to remember to do that itself.
     *
     * If secure storage refuses the token (Keystore invalidated, encryption
     * failure, disk error) the result is a failure saying so and the user is
     * NOT signed in. There is deliberately no fallback to plain storage.
     */
    suspend fun login(email: String, password: String): Result<AuthenticatedUser> {
        val body = try {
            val response = authApi.login(
                LoginRequest(email = email, password = password, client = LoginRequest.Client.mobile),
            )
            val parsed = response.body()
            if (!response.isSuccessful || parsed == null) {
                return Result.failure(
                    AuthException(response.code(), parseApiError(response.errorBody()?.string())),
                )
            }
            parsed
        } catch (e: IOException) {
            return Result.failure(AuthException(null, UNREACHABLE_MESSAGE, e))
        } catch (e: SerializationException) {
            return Result.failure(AuthException(null, UNPARSEABLE_MESSAGE, e))
        }

        val token = body.token
            // Would mean the server treated this as a web login despite
            // client: "mobile" — a contract violation, not a user-facing
            // "wrong password" case, so it gets its own message.
            ?: return Result.failure(
                AuthException(null, "Sign-in succeeded but the server didn't return a session token."),
            )

        // Broad on purpose: EncryptedSharedPreferences/Keystore failures arrive as
        // SecurityException, GeneralSecurityException wrappers, IOException or plain
        // RuntimeExceptions depending on the device. saveToken is not suspending, so
        // this cannot swallow a coroutine cancellation.
        try {
            tokenStore.saveToken(token)
        } catch (e: Exception) {
            return Result.failure(AuthException(null, SECURE_STORAGE_FAILED_MESSAGE, e))
        }
        return Result.success(body.user.toAuthenticatedUser())
    }

    /**
     * Resolves the signed-in user from the stored token via `GET /api/auth/me`
     * — the authenticated round trip that proves the token [AuthInterceptor]
     * attached is one the server still accepts. Used on cold start: a stored
     * token alone only proves something was saved once, not that the session
     * is still live (it may have expired or been revoked server-side).
     *
     * The failure is an [AuthException]; only [AuthException.isUnauthorized]
     * means the token is dead. Anything else (offline, timeout, 5xx) says
     * nothing about the token and the caller must keep it.
     */
    suspend fun currentUser(): Result<AuthenticatedUser> = try {
        val response = authApi.getMe()
        val body = response.body()
        if (response.isSuccessful && body != null) {
            Result.success(body.user.toAuthenticatedUser())
        } else {
            Result.failure(AuthException(response.code(), parseApiError(response.errorBody()?.string())))
        }
    } catch (e: IOException) {
        Result.failure(AuthException(null, UNREACHABLE_MESSAGE, e))
    } catch (e: SerializationException) {
        Result.failure(AuthException(null, UNPARSEABLE_MESSAGE, e))
    }

    /**
     * Local clear FIRST, then a best-effort server-side revoke with the token value read before clearing.
     *
     * "Sign out" is a promise about what THIS device does, not about how fast the server's own record catches up, and
     * the revoke can take as long as the connection timeout. If the token were cleared after the round trip, a process
     * killed meanwhile would sign the previous user back in on the next launch, and a sign-in as someone else during the
     * round trip would be wiped by the late clear. Cleared first, neither can happen; the revoke that follows cannot
     * touch the store.
     *
     * Throws (after the revoke attempt) if the local clear itself failed; see [TokenStore.clear].
     */
    suspend fun logout() {
        val token = try {
            tokenStore.token()
        } catch (e: Exception) {
            null
        }
        val clearFailure = try {
            tokenStore.clear()
            null
        } catch (e: Exception) {
            e
        }
        try {
            when {
                token == null -> Unit // nothing was stored, so there is nothing to revoke
                revoke != null -> revoke.invoke(token)
                else -> authApi.logout()
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: IOException) {
            // Network failure: the local clear above already happened.
        } catch (_: SerializationException) {
            // Logout's 204 has no body; an unexpected body that fails to parse changes nothing locally.
        }
        if (clearFailure != null) throw clearFailure
    }

    /** Drops a stale local token (e.g. the server answered 401) without calling the API — there is nothing valid left to revoke. */
    fun forgetLocalSession() {
        tokenStore.clear()
    }

    private fun parseApiError(raw: String?): String {
        val fallback = "Something went wrong. Please try again."
        if (raw.isNullOrEmpty()) return fallback
        return runCatching { json.decodeFromString(ApiError.serializer(), raw) }
            .getOrNull()
            ?.message
            ?: fallback
    }

    private companion object {
        const val UNREACHABLE_MESSAGE = "Couldn't reach the API. Check the connection and API_BASE_URL."
        const val UNPARSEABLE_MESSAGE = "The API returned something this app couldn't parse."
        const val SECURE_STORAGE_FAILED_MESSAGE =
            "Couldn't save your session to secure storage on this device, so you were not signed in. " +
                "Try again; if it keeps happening, restart the phone."
    }
}

/** See [AuthenticatedUser]'s doc comment for why this mapping exists at all. */
private fun AuthResponseUser.toAuthenticatedUser() = AuthenticatedUser(id = id, email = email, displayName = displayName)

/** See [AuthenticatedUser]'s doc comment for why this mapping exists at all. */
private fun MeResponseUser.toAuthenticatedUser() = AuthenticatedUser(id = id, email = email, displayName = displayName)
