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
import com.folusayo.kobolink.checkout.ApiCheckoutGateway
import com.folusayo.kobolink.checkout.CheckoutController
import com.folusayo.kobolink.checkout.CheckoutGateway
import com.folusayo.kobolink.checkout.CheckoutState
import com.folusayo.kobolink.checkout.PendingCheckoutStore
import com.folusayo.kobolink.checkout.code
import com.folusayo.kobolink.ui.screen.CheckoutFormState
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
    checkoutGateway: CheckoutGateway,
    pendingCheckouts: PendingCheckoutStore,
) : ViewModel() {

    val sessionState: StateFlow<SessionState> = session.state

    /**
     * What the payer has typed. Outlives the screen's content for the same reason [checkout] does, and is emptied
     * by [checkout] itself (synchronously) on sign-out, a user change, a different link, and Back.
     */
    val checkoutForm = CheckoutFormState()

    /**
     * The payer checkout (M3). Lives here, not in the screen, so a rotation neither drops a loaded
     * link nor re-runs its lookup; all of its logic is in [CheckoutController], which is JVM-tested.
     * Who an attempt belongs to follows the session ([SessionController.attemptOwner]).
     */
    val checkout = CheckoutController(
        gateway = checkoutGateway,
        scope = viewModelScope,
        store = pendingCheckouts,
        ownerNow = { session.attemptOwner },
        clearForm = checkoutForm::reset,
    )

    /** A chosen sign-out was refused because the checkout could not make its clean-up safe (the token is kept). */
    val signOutBlocked: StateFlow<Boolean> = session.signOutBlocked

    fun acknowledgeSignOutBlocked() = session.acknowledgeSignOutBlocked()

    /** Is there an unfinished payment made under a session on this device, worth a warning before signing out? */
    fun hasSessionAttempts(): Boolean = checkout.hasSessionAttempts

    /** A tapped link: always a fresh lookup, even for the link already on screen (M1 review, item a). */
    fun openLink(code: String) {
        checkout.open(code)
    }

    /** A link URL with no readable code: the not-found checkout, not the merchant login. */
    fun openUnreadableLink() {
        checkout.openUnreadable()
    }

    fun open(link: LinkRef) {
        when (link) {
            LinkRef.None -> Unit
            is LinkRef.Code -> openLink(link.code)
            LinkRef.Unreadable -> openUnreadableLink()
        }
    }

    /** Is a merchant token stored on this device? Answered synchronously, before the cold-start check has run. */
    fun hasStoredSession(): Boolean = session.hasStoredSession()

    fun closeLink() {
        checkout.close()
    }

    /** The link on screen right now, for `onSaveInstanceState`. */
    fun currentLink(): LinkRef = when (val state = checkout.state.value) {
        CheckoutState.Idle -> LinkRef.None
        is CheckoutState.NotFound -> state.code?.let { LinkRef.Code(it) } ?: LinkRef.Unreadable
        else -> state.code?.let { LinkRef.Code(it) } ?: LinkRef.None
    }

    init {
        // The checkout follows the session through two synchronous hooks, set before anything can happen to it: it is
        // asked BEFORE a chosen sign-out (and can refuse it), and told of every change right after it, so the form and
        // the unsettled payments of whoever was here are gone before anything can render or the network is touched.
        session.willSignOut = checkout::prepareSignOut
        session.onChange = checkout::sessionDidChange
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

    /**
     * The person asked to sign out. [SessionController.logout] asks the checkout first ([CheckoutController.prepareSignOut])
     * and does nothing if the clean-up cannot be made safe ([signOutBlocked]); otherwise the checkout forgets the
     * unsettled payments and the form before the network is touched. An expired session does neither.
     */
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
                    checkoutGateway = ApiCheckoutGateway(ApiClientProvider.links, ApiClientProvider.checkout, ApiClientProvider.json),
                    pendingCheckouts = ApiClientProvider.pendingCheckouts,
                )
            }
        }
    }
}
