package com.folusayo.kobolink

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.folusayo.kobolink.api.ApiClientProvider
import com.folusayo.kobolink.auth.AuthRepository
import com.folusayo.kobolink.auth.AuthenticatedUser
import com.folusayo.kobolink.auth.SessionController
import com.folusayo.kobolink.auth.SessionState
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * Holds the session across Activity recreation (rotation, theme change). The
 * cold-start `/api/auth/me` check runs once, here, when the ViewModel is
 * first created — not in a composable effect that would re-run every time the
 * Activity is rebuilt. All session logic lives in [SessionController], which
 * is JVM-tested; this class only supplies a lifecycle-scoped coroutine scope.
 */
class MainViewModel(
    private val session: SessionController,
    sessionExpired: Flow<Unit>,
) : ViewModel() {

    val sessionState: StateFlow<SessionState> = session.state

    /**
     * The deep-link code the user backed out of, so the re-parse of the launch
     * Intent that follows a rotation does not bring the dismissed link back.
     * Reset by `MainActivity.onNewIntent`: a fresh tap is a fresh request.
     */
    var dismissedLinkCode: String? = null

    init {
        // Subscribe before resolving so an expiry signalled by the very first
        // request is not missed.
        viewModelScope.launch { session.observeExpiry(sessionExpired) }
        viewModelScope.launch { session.resolve() }
    }

    fun retry() {
        viewModelScope.launch { session.retry() }
    }

    /**
     * Runs in [viewModelScope] so a rotation mid-request cannot cancel the
     * call between the server accepting the login and the token being saved;
     * the caller (the login screen) just awaits the outcome.
     */
    suspend fun login(email: String, password: String): Result<AuthenticatedUser> =
        viewModelScope.async { session.login(email, password) }.await()

    fun logout() {
        viewModelScope.launch { session.logout() }
    }

    companion object {
        val Factory = viewModelFactory {
            initializer {
                MainViewModel(
                    session = SessionController(
                        AuthRepository(ApiClientProvider.auth, ApiClientProvider.tokenStore, ApiClientProvider.json),
                    ),
                    sessionExpired = ApiClientProvider.sessionExpiry.events,
                )
            }
        }
    }
}
