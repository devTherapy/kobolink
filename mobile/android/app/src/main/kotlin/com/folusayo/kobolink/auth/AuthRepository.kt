package com.folusayo.kobolink.auth

import com.folusayo.kobolink.generated.api.apis.AuthApi
import com.folusayo.kobolink.generated.api.models.ApiError
import com.folusayo.kobolink.generated.api.models.AuthResponseUser
import com.folusayo.kobolink.generated.api.models.LoginRequest
import com.folusayo.kobolink.generated.api.models.MeResponseUser
import java.io.IOException
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/**
 * The one place that turns `AuthApi` calls into a signed-in/signed-out state
 * change. Every branch that can end in "we are now signed in" writes the
 * token through [tokenStore] (never anywhere else); every branch that ends
 * in "we are now signed out" clears it the same way, unconditionally.
 */
class AuthRepository(
    private val authApi: AuthApi,
    private val tokenStore: TokenStore,
    private val json: Json,
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
     */
    suspend fun login(email: String, password: String): Result<AuthenticatedUser> = try {
        val response = authApi.login(
            LoginRequest(email = email, password = password, client = LoginRequest.Client.mobile),
        )
        val body = response.body()
        when {
            !response.isSuccessful || body == null ->
                Result.failure(RuntimeException(parseApiError(response.errorBody()?.string())))
            body.token == null ->
                // Would mean the server treated this as a web login despite
                // client: "mobile" — a contract violation, not a user-facing
                // "wrong password" case, so it gets its own message.
                Result.failure(RuntimeException("Sign-in succeeded but the server didn't return a session token."))
            else -> {
                tokenStore.saveToken(body.token!!)
                Result.success(body.user.toAuthenticatedUser())
            }
        }
    } catch (e: IOException) {
        Result.failure(RuntimeException("Couldn't reach the API. Check the connection and API_BASE_URL.", e))
    } catch (e: SerializationException) {
        Result.failure(RuntimeException("The API returned something this app couldn't parse.", e))
    }

    /**
     * Resolves the signed-in user from the stored token via `GET /api/auth/me`
     * — the authenticated round trip that proves the token [AuthInterceptor]
     * attached is one the server still accepts. Used on cold start: a stored
     * token alone only proves something was saved once, not that the session
     * is still live (it may have expired or been revoked server-side).
     */
    suspend fun currentUser(): Result<AuthenticatedUser> = try {
        val response = authApi.getMe()
        val body = response.body()
        if (response.isSuccessful && body != null) {
            Result.success(body.user.toAuthenticatedUser())
        } else {
            Result.failure(RuntimeException(parseApiError(response.errorBody()?.string())))
        }
    } catch (e: IOException) {
        Result.failure(RuntimeException("Couldn't reach the API. Check the connection and API_BASE_URL.", e))
    } catch (e: SerializationException) {
        Result.failure(RuntimeException("The API returned something this app couldn't parse.", e))
    }

    /**
     * Best-effort server-side revoke, then an unconditional local clear.
     * Even when `POST /api/auth/logout` never reaches the server (airplane
     * mode, a dropped connection), the credential still comes out of
     * [tokenStore]: "sign out" is a promise about what THIS device does
     * next, not about how fast the server's own record catches up, and the
     * done-when this feature ships against is specifically that the token is
     * actually removed from encrypted storage, not merely forgotten in
     * memory.
     */
    suspend fun logout() {
        try {
            authApi.logout()
        } catch (_: IOException) {
            // Network failure — the local clear below still happens.
        } catch (_: SerializationException) {
            // Logout's 204 has no body; an unexpected body that fails to
            // parse is not a reason to leave the local credential in place.
        } finally {
            tokenStore.clear()
        }
    }

    /** Drops a stale local token (e.g. `currentUser()` found it already expired/revoked) without calling the API — there is nothing valid left to revoke. */
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
}

/** See [AuthenticatedUser]'s doc comment for why this mapping exists at all. */
private fun AuthResponseUser.toAuthenticatedUser() = AuthenticatedUser(id = id, email = email, displayName = displayName)

/** See [AuthenticatedUser]'s doc comment for why this mapping exists at all. */
private fun MeResponseUser.toAuthenticatedUser() = AuthenticatedUser(id = id, email = email, displayName = displayName)
