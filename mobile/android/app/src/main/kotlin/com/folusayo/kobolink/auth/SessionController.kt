package com.folusayo.kobolink.auth

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Where the app is in the sign-in lifecycle. */
sealed interface SessionState {
    /** Cold start with a stored token that has not been checked against the server yet. */
    data object Resolving : SessionState

    /** No usable session. [notice] explains why when the user did not ask for it (e.g. it expired). */
    data class SignedOut(val notice: String? = null) : SessionState

    data class SignedIn(val user: AuthenticatedUser) : SessionState

    /** A token is stored but the server could not be reached to confirm it. The token is kept. */
    data class Offline(val message: String) : SessionState
}

/**
 * Every decision about the session — cold-start check, login, logout,
 * mid-session expiry — as plain Kotlin with no Android types, so it runs in
 * JVM unit tests. [MainViewModel][com.folusayo.kobolink.MainViewModel] owns
 * one instance across Activity recreation.
 *
 * The invariant: a stored token is destroyed only on a definitive 401 (or an
 * explicit logout). Transient failures keep it.
 */
class SessionController(private val auth: AuthRepository) {
    private val _state = MutableStateFlow<SessionState>(SessionState.Resolving)
    val state: StateFlow<SessionState> = _state.asStateFlow()

    private var resolveStarted = false

    /**
     * The cold-start check. One-shot: a second call (the Activity being
     * recreated by a rotation, say) does nothing.
     */
    suspend fun resolve() {
        if (resolveStarted) return
        resolveStarted = true
        check()
    }

    /** Re-runs the check after [SessionState.Offline]; ignored in any other state. */
    suspend fun retry() {
        if (_state.value !is SessionState.Offline) return
        _state.value = SessionState.Resolving
        check()
    }

    private suspend fun check() {
        // Reading the token can itself fail (Keystore/decryption). Fail safe to signed-out with a
        // message naming secure storage: never crash, never fall back to plain storage.
        val hasToken = try {
            auth.isSignedIn
        } catch (e: Exception) {
            _state.value = SessionState.SignedOut(notice = STORAGE_UNREADABLE_NOTICE)
            return
        }
        if (!hasToken) {
            _state.value = SessionState.SignedOut()
            return
        }
        auth.currentUser().fold(
            onSuccess = { _state.value = SessionState.SignedIn(it) },
            onFailure = { error ->
                val failure = error as? AuthException
                _state.value = if (failure?.isUnauthorized == true) {
                    discardDeadToken()
                    SessionState.SignedOut(notice = SESSION_ENDED_NOTICE)
                } else {
                    SessionState.Offline(offlineMessage(failure?.httpStatus))
                }
            },
        )
    }

    /**
     * The server said 401, so the token is dead. [AuthInterceptor] has normally
     * cleared it already; only clear if it is still there. A failed clear must
     * not stop the move to signed-out (that would crash-loop every launch while
     * storage can't write): the next launch gets the same 401 and tries again.
     */
    private fun discardDeadToken() {
        try {
            if (auth.isSignedIn) auth.forgetLocalSession()
        } catch (e: Exception) {
            // Deliberately ignored; see above.
        }
    }

    suspend fun login(email: String, password: String): Result<AuthenticatedUser> =
        auth.login(email, password).onSuccess { _state.value = SessionState.SignedIn(it) }

    suspend fun logout() {
        _state.value = try {
            auth.logout()
            SessionState.SignedOut()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The device could not remove the token. Don't crash, and don't claim a clean sign-out.
            SessionState.SignedOut(notice = LOGOUT_INCOMPLETE_NOTICE)
        }
    }

    /** The server rejected the token on a request made while signed in (see [AuthInterceptor]; it has already cleared the token). */
    fun onSessionExpired() {
        if (_state.value is SessionState.SignedIn) {
            _state.value = SessionState.SignedOut(notice = SESSION_ENDED_NOTICE)
        }
    }

    suspend fun observeExpiry(events: Flow<Unit>) {
        events.collect { onSessionExpired() }
    }

    private fun offlineMessage(httpStatus: Int?) = if (httpStatus != null) {
        "Kobolink had a problem confirming your session (error $httpStatus). You're still signed in. Try again in a moment."
    } else {
        "Couldn't reach Kobolink to confirm your session. You're still signed in. Check your connection and try again."
    }

    private companion object {
        const val STORAGE_UNREADABLE_NOTICE =
            "Couldn't read your saved session from secure storage on this device, so you're signed out. Sign in again."
        const val SESSION_ENDED_NOTICE = "Your session ended. Sign in again to continue."
        const val LOGOUT_INCOMPLETE_NOTICE =
            "Signed out, but this device couldn't remove your saved session. Restart the app and sign out again."
    }
}
