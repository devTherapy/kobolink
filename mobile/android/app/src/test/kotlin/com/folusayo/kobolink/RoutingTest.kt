package com.folusayo.kobolink

import com.folusayo.kobolink.auth.SessionState
import com.folusayo.kobolink.auth.ngozi
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Product rule (docs/DESIGN-SPEC.md 4.3 and 11): the payer-facing deep-link
 * landing is public and never sits behind merchant sign-in. Sign-in gates
 * only the merchant screens (Home / wallet).
 */
class RoutingTest {

    private val sessions = listOf(
        "resolving" to SessionState.Resolving,
        "offline" to SessionState.Offline("no connection"),
        "signed out" to SessionState.SignedOut(),
        "signed out with notice" to SessionState.SignedOut("Your session ended."),
        "signed in" to SessionState.SignedIn(ngozi),
    )

    @Test
    fun `a deep link reaches the checkout in every session state`() {
        for ((name, session) in sessions) {
            assertEquals("session: $name", Destination.Link, route(session, linkOpen = true))
        }
    }

    @Test
    fun `without a link the session decides`() {
        assertEquals(Destination.Resolving, route(SessionState.Resolving, linkOpen = false))
        assertEquals(Destination.Offline("no connection"), route(SessionState.Offline("no connection"), linkOpen = false))
        assertEquals(Destination.Login(null), route(SessionState.SignedOut(), linkOpen = false))
        assertEquals(Destination.Login("Your session ended."), route(SessionState.SignedOut("Your session ended."), linkOpen = false))
        assertEquals(Destination.Home(ngozi), route(SessionState.SignedIn(ngozi), linkOpen = false))
    }

    @Test
    fun `an open link survives the session changing underneath it`() {
        // Signed out with a link, then the user signs in: still the checkout.
        assertEquals(Destination.Link, route(SessionState.SignedOut(), linkOpen = true))
        assertEquals(Destination.Link, route(SessionState.SignedIn(ngozi), linkOpen = true))
    }

    @Test
    fun `dismissing the link falls through to home when signed in`() {
        // backFromLink says DismissLink; the checkout closes and the next route() call has no link.
        assertEquals(BackAction.DismissLink, backFromLink(SessionState.SignedIn(ngozi)))
        assertEquals(Destination.Home(ngozi), route(SessionState.SignedIn(ngozi), linkOpen = false))
    }

    // linkToOpenOnCreate: the onCreate decision the M1 review found untested.

    private val a = LinkRef.Code("AAAAAAAA")
    private val b = LinkRef.Code("BBBBBBBB")

    private fun open(
        restored: Boolean = false,
        checkoutIsOpen: Boolean = false,
        saved: LinkRef = LinkRef.None,
        fromHistory: Boolean = false,
        intent: LinkRef = LinkRef.None,
    ) = linkToOpenOnCreate(restored, checkoutIsOpen, saved, fromHistory, intent)

    @Test
    fun `a first launch opens the link in the intent`() {
        assertEquals(a, open(intent = a))
        assertEquals(LinkRef.Unreadable, open(intent = LinkRef.Unreadable))
        assertEquals(LinkRef.None, open(intent = LinkRef.None))
    }

    @Test
    fun `rotation opens nothing, the view model already has the checkout`() {
        assertEquals(LinkRef.None, open(restored = true, checkoutIsOpen = true, saved = a, intent = b))
    }

    @Test
    fun `after process death the link that was on screen reopens, not the one in the launch intent`() {
        // Cold-started on link B's tap after link A: Android rebuilds with the ORIGINAL intent (A), but B was on screen.
        assertEquals(b, open(restored = true, saved = b, intent = a))
        // Started from the launcher, then a link was tapped: the rebuilt intent is a launcher intent.
        assertEquals(a, open(restored = true, saved = a, intent = LinkRef.None))
        assertEquals(LinkRef.Unreadable, open(restored = true, saved = LinkRef.Unreadable, intent = a))
    }

    @Test
    fun `after process death a link the user had closed stays closed`() {
        assertEquals(LinkRef.None, open(restored = true, saved = LinkRef.None, intent = a))
    }

    @Test
    fun `a start from Recents does not reopen a stale link`() {
        assertEquals(LinkRef.None, open(fromHistory = true, intent = a))
    }

    @Test
    fun `the saved form round-trips every kind of link`() {
        for (ref in listOf(LinkRef.None, a, LinkRef.Unreadable)) {
            assertEquals(ref, linkRefFromSaved(ref.toSaved()))
        }
        assertEquals(null, LinkRef.None.toSaved())
    }

    /**
     * M1 review (e). A payer who taps a shared link, is not a merchant and presses Back must
     * leave the app, not land on the merchant login screen they never asked for. Only a device
     * that actually holds a merchant session has somewhere to go back to.
     */
    @Test
    fun `back from a link with no merchant session leaves the app`() {
        assertEquals(BackAction.LeaveApp, backFromLink(SessionState.SignedOut()))
        assertEquals(BackAction.LeaveApp, backFromLink(SessionState.SignedOut("Your session ended.")))
    }

    @Test
    fun `back from a link while signed in returns to home`() {
        assertEquals(BackAction.DismissLink, backFromLink(SessionState.SignedIn(ngozi)))
    }

    @Test
    fun `back from a link while a stored session is unconfirmed returns to that session, not out of the app`() {
        // Resolving and Offline both mean a token is stored: this is a merchant's device,
        // and dropping the app would strand them mid-check. The next screen is the one
        // that confirms (or fails to confirm) the session.
        assertEquals(BackAction.DismissLink, backFromLink(SessionState.Resolving))
        assertEquals(BackAction.DismissLink, backFromLink(SessionState.Offline("no connection")))
    }
}
