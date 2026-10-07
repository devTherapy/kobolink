package com.folusayo.kobolink

import com.folusayo.kobolink.auth.AuthenticatedUser
import com.folusayo.kobolink.auth.SessionState

/** What [MainActivity] puts on screen. */
sealed interface Destination {
    data object Resolving : Destination
    data class Offline(val message: String) : Destination
    data class Login(val notice: String?) : Destination
    data class Home(val user: AuthenticatedUser) : Destination

    /**
     * The payer checkout. Which link, and every state it can be in, belongs to
     * [com.folusayo.kobolink.checkout.CheckoutController]; routing only decides
     * *whether* it is the screen.
     */
    data object Link : Destination
}

/**
 * The deep-link landing is the public payer flow (docs/DESIGN-SPEC.md 4.3 and
 * 11): an open link always wins, whatever the session state, so a payer is
 * never sent through merchant sign-in to reach a payment link. Sign-in gates
 * only the merchant screens. Closing the link ([backFromLink]) makes the next
 * call fall through to the session: Home if signed in, otherwise login.
 */
fun route(session: SessionState, linkOpen: Boolean): Destination {
    if (linkOpen) return Destination.Link
    return when (session) {
        is SessionState.Resolving -> Destination.Resolving
        is SessionState.Offline -> Destination.Offline(session.message)
        is SessionState.SignedOut -> Destination.Login(session.notice)
        is SessionState.SignedIn -> Destination.Home(session.user)
    }
}

/** What Back (or the checkout's close button) does while a link is on screen. */
sealed interface BackAction {
    /** Close the link and show whatever the session says: Home, or the offline/resolving screen. */
    data object DismissLink : BackAction

    /** Finish the activity: there is no merchant session to go back to. */
    data object LeaveApp : BackAction
}

/**
 * Back from a checkout.
 *
 * M1's rule was "Back clears the link, then [route] falls through to the
 * session", which for a payer with no merchant session meant Back from the
 * checkout landed on the merchant login screen: a screen they never asked
 * for, in an app they only opened to pay one link. The sane behaviour is that
 * Back goes where the user came from, and for a payer that is the app that
 * held the link (WhatsApp, Messages, a browser): finish the activity.
 *
 * Only a device that holds a merchant session has something in this app to go
 * back to. [SessionState.Resolving] and [SessionState.Offline] both mean a
 * token is stored, which is a merchant's device, so they dismiss to the
 * screen that confirms the session rather than silently dropping the app.
 * [SessionState.SignedOut] has no token, so there is nothing to go back to.
 *
 * A deep link stays reachable whatever the session is ([route]); this only
 * decides what Back does once it is open.
 */
fun backFromLink(session: SessionState): BackAction = when (session) {
    is SessionState.SignedOut -> BackAction.LeaveApp
    is SessionState.SignedIn, is SessionState.Resolving, is SessionState.Offline -> BackAction.DismissLink
}

/**
 * Whether `onCreate` should (re)open the link carried by the launch Intent.
 *
 * - First launch ([restoredFromSavedState] false): yes.
 * - Rotation / theme change: the process and the ViewModel survive, so the
 *   checkout is already open (or was deliberately closed); re-opening it would
 *   re-run the lookup and drop the payer's state, and re-opening a link the user
 *   had backed out of would resurrect it.
 * - Process death: the ViewModel is gone but the Intent is not. Re-open it,
 *   unless the user had already closed the link before the process died.
 *
 * (M1 review: this was an untested branch in `MainActivity.onCreate`, and its
 * earlier "skip when savedInstanceState != null" form wiped the deep link on
 * rotation.)
 */
fun shouldOpenLaunchLink(
    restoredFromSavedState: Boolean,
    checkoutIsOpen: Boolean,
    linkWasClosed: Boolean,
): Boolean = when {
    !restoredFromSavedState -> true
    checkoutIsOpen -> false
    else -> !linkWasClosed
}
