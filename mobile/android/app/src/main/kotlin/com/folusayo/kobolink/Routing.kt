package com.folusayo.kobolink

import com.folusayo.kobolink.auth.AuthenticatedUser
import com.folusayo.kobolink.auth.SessionState

/** What [MainActivity] puts on screen. */
sealed interface Destination {
    data object Resolving : Destination
    data class Offline(val message: String) : Destination
    data class Login(val notice: String?) : Destination
    data class Home(val user: AuthenticatedUser) : Destination
    data class Link(val code: String) : Destination
}

/**
 * The deep-link landing is the public payer flow (docs/DESIGN-SPEC.md 4.3 and
 * 11): a pending link code always wins, whatever the session state, so a payer
 * is never sent through merchant sign-in to reach a payment link. Sign-in gates
 * only the merchant screens. `MainActivity` clears the code on Back, so the
 * next call falls through to the session: Home if signed in, otherwise login.
 */
fun route(session: SessionState, deepLinkCode: String?): Destination {
    if (deepLinkCode != null) return Destination.Link(deepLinkCode)
    return when (session) {
        is SessionState.Resolving -> Destination.Resolving
        is SessionState.Offline -> Destination.Offline(session.message)
        is SessionState.SignedOut -> Destination.Login(session.notice)
        is SessionState.SignedIn -> Destination.Home(session.user)
    }
}
