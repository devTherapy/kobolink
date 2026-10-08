package com.folusayo.kobolink.auth

import com.folusayo.kobolink.checkout.AttemptOwner
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
 * A change to who is signed in that per-user state elsewhere in the app must react to (the checkout forgets a
 * person's payment attempts and form on the first two kinds of sign-out and sign-in, and on none of the involuntary
 * ones). Reported synchronously, right after [SessionController.state] changed (or, for [SignedOutByChoice], before
 * the network is touched), so nothing can render in between. The same four events as iOS's `SessionChange`.
 */
sealed interface SessionChange {
    /** The cold-start check (or Try again after offline) confirmed [user] for the token already stored: the same session, now with a name. */
    data class Resolved(val user: AuthenticatedUser) : SessionChange

    /** A sign-in with credentials produced [user] and a new token. */
    data class SignedIn(val user: AuthenticatedUser) : SessionChange

    /** The person chose Sign out. Their per-user state must go. */
    data object SignedOutByChoice : SessionChange

    /** The server ended the session (a 401). Involuntary: it says nothing about who is at the screen, so nothing is forgotten. */
    data object Ended : SessionChange
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

    /** Told about every [SessionChange], once, in order. Set once at startup by the code that owns the per-user state. */
    var onChange: ((SessionChange) -> Unit)? = null

    /**
     * Asked BEFORE a chosen sign-out changes anything. False means per-user state could not be made safe to forget
     * (its clearing could be lost by a restart), so the person stays signed in, the token is kept, and
     * [signOutBlocked] says so.
     */
    var willSignOut: (() -> Boolean)? = null

    private val _signOutBlocked = MutableStateFlow(false)

    /** A chosen sign-out was refused by [willSignOut]. The token is kept and nothing was revoked. */
    val signOutBlocked: StateFlow<Boolean> = _signOutBlocked.asStateFlow()

    fun acknowledgeSignOutBlocked() {
        _signOutBlocked.value = false
    }

    /**
     * Who a payment attempt started right now belongs to; see [AttemptOwner] for the rule. With no stored session it
     * is a payer. With one, signed in or not yet confirmed (resolving, offline, or a session whose token could not
     * be read), it is a session, with the user's id once the server has said who.
     */
    val attemptOwner: AttemptOwner
        get() = when (val current = _state.value) {
            is SessionState.SignedIn -> AttemptOwner.Session(current.user.id)
            SessionState.Resolving, is SessionState.Offline -> AttemptOwner.Session(null)
            // A token may be there that this device could not read: not a payer's device.
            is SessionState.SignedOut ->
                if (current.notice == STORAGE_UNREADABLE_NOTICE) AttemptOwner.Session(null) else AttemptOwner.Payer
        }

    /**
     * The cold-start check. One-shot: a second call (the Activity being
     * recreated by a rotation, say) does nothing.
     */
    suspend fun resolve() {
        if (resolveStarted) return
        resolveStarted = true
        check()
    }

    /**
     * Is a session token stored on this device? Synchronous and independent of [state], which stays
     * [SessionState.Resolving] until the cold-start check has run: `MainActivity.onCreate` has to decide what a
     * start from Recents opens before then. Unreadable storage is "no", the same fail-safe [resolve] uses (it
     * signs out rather than crash).
     */
    fun hasStoredSession(): Boolean = try {
        auth.isSignedIn
    } catch (e: Exception) {
        false
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
            onSuccess = {
                _state.value = SessionState.SignedIn(it)
                onChange?.invoke(SessionChange.Resolved(it))
            },
            onFailure = { error ->
                val failure = error as? AuthException
                if (failure?.isUnauthorized == true) {
                    discardDeadToken()
                    _state.value = SessionState.SignedOut(notice = SESSION_ENDED_NOTICE)
                    onChange?.invoke(SessionChange.Ended)
                } else {
                    _state.value = SessionState.Offline(offlineMessage(failure?.httpStatus))
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
        auth.login(email, password).onSuccess {
            _state.value = SessionState.SignedIn(it)
            onChange?.invoke(SessionChange.SignedIn(it))
        }

    /**
     * Explicit sign-out. First [willSignOut] is asked: if the per-user state cannot be made safe to forget, nothing
     * happens (token kept, no network call) and [signOutBlocked] is set. Then the per-user state is forgotten
     * ([SessionChange.SignedOutByChoice]) BEFORE the network is touched; the revoke that follows is best effort.
     */
    suspend fun logout() {
        if (willSignOut?.invoke() == false) {
            _signOutBlocked.value = true
            return
        }
        _signOutBlocked.value = false
        onChange?.invoke(SessionChange.SignedOutByChoice)
        // Signed out NOW, before the revoke goes over the network: a link opened while it is in the air must not pay
        // as the user who just left (an attempt with their owner id would be missing from the obligation, and would be
        // shown to the next person). From here on an attempt is a payer's.
        _state.value = SessionState.SignedOut()
        try {
            auth.logout()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The device could not remove the token. Don't crash, and don't claim a clean sign-out.
            _state.value = SessionState.SignedOut(notice = LOGOUT_INCOMPLETE_NOTICE)
        }
    }

    /** The server rejected the token on a request made while signed in (see [AuthInterceptor]; it has already cleared the token). */
    fun onSessionExpired() {
        if (_state.value is SessionState.SignedIn) {
            _state.value = SessionState.SignedOut(notice = SESSION_ENDED_NOTICE)
            onChange?.invoke(SessionChange.Ended)
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
