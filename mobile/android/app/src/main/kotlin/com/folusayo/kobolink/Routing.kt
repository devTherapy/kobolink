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

/** A link the checkout is showing, in a form that survives process death. */
sealed interface LinkRef {
    data object None : LinkRef
    data class Code(val code: String) : LinkRef

    /** A link URL with no readable code: the not-found checkout. */
    data object Unreadable : LinkRef
}

private const val UNREADABLE_MARKER = ""

/** For `onSaveInstanceState`: null when no link is open. [LinkRef.Unreadable] is the empty string. */
fun LinkRef.toSaved(): String? = when (this) {
    LinkRef.None -> null
    LinkRef.Unreadable -> UNREADABLE_MARKER
    is LinkRef.Code -> code
}

fun linkRefFromSaved(saved: String?): LinkRef = when {
    saved == null -> LinkRef.None
    saved == UNREADABLE_MARKER -> LinkRef.Unreadable
    else -> LinkRef.Code(saved)
}

/**
 * Which link `onCreate` should open.
 *
 * - The checkout is already open ([checkoutIsOpen]): a rotation or theme change. The ViewModel has it; opening
 *   again would re-run the lookup for nothing. [LinkRef.None].
 * - Restored after process death ([restoredFromSavedState]): open what was ON SCREEN, [savedLink]. The activity's
 *   launch Intent is not that: `onNewIntent` replaces the in-process intent, but Android rebuilds a killed activity
 *   with the ORIGINAL launch Intent, so trusting it would reopen link A after the payer had moved on to link B, or
 *   find only a launcher Intent and drop the checkout. Nothing saved means nothing was open (it had been closed).
 * - A fresh start from Recents ([fromHistory]) on a device that holds a merchant session ([hasMerchantSession]): the
 *   Intent is stale, a link from whenever the task began, and a merchant's Recents card is the app, not that link.
 *   None, so [route] falls through to Home.
 * - A fresh start from Recents with NO merchant session: this is a payer, and the Recents card they tapped is the
 *   checkout they had open. The same stale-looking Intent is the only record of it, and the alternative is the
 *   merchant login, the one screen a payer has no use for (M3 review, D3; M2 review #37). Their Intent's link, if it
 *   has one: a launcher Intent carries none, and that start is the login, correctly.
 * - Otherwise, a fresh start: the Intent's link.
 */
fun linkToOpenOnCreate(
    restoredFromSavedState: Boolean,
    checkoutIsOpen: Boolean,
    savedLink: LinkRef,
    fromHistory: Boolean,
    intentLink: LinkRef,
    hasMerchantSession: Boolean,
): LinkRef = when {
    checkoutIsOpen -> LinkRef.None
    restoredFromSavedState -> savedLink
    fromHistory && hasMerchantSession -> LinkRef.None
    else -> intentLink
}
