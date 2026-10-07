package com.folusayo.kobolink

import com.folusayo.kobolink.auth.SessionState
import com.folusayo.kobolink.auth.ngozi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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

    // shouldOpenLaunchLink: the onCreate decision the M1 review found untested.

    @Test
    fun `a first launch opens the link in the intent`() {
        assertTrue(shouldOpenLaunchLink(restoredFromSavedState = false, checkoutIsOpen = false, linkWasClosed = false))
    }

    @Test
    fun `rotation does not reopen a link that is already open`() {
        assertFalse(shouldOpenLaunchLink(restoredFromSavedState = true, checkoutIsOpen = true, linkWasClosed = false))
    }

    @Test
    fun `rotation does not resurrect a link the user backed out of`() {
        assertFalse(shouldOpenLaunchLink(restoredFromSavedState = true, checkoutIsOpen = false, linkWasClosed = true))
    }

    @Test
    fun `process death while the link was on screen reopens it`() {
        assertTrue(shouldOpenLaunchLink(restoredFromSavedState = true, checkoutIsOpen = false, linkWasClosed = false))
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
