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
    fun `a deep link reaches the link screen in every session state`() {
        for ((name, session) in sessions) {
            assertEquals("session: $name", Destination.Link("abc12345"), route(session, "abc12345"))
        }
    }

    @Test
    fun `without a link the session decides`() {
        assertEquals(Destination.Resolving, route(SessionState.Resolving, null))
        assertEquals(Destination.Offline("no connection"), route(SessionState.Offline("no connection"), null))
        assertEquals(Destination.Login(null), route(SessionState.SignedOut(), null))
        assertEquals(Destination.Login("Your session ended."), route(SessionState.SignedOut("Your session ended."), null))
        assertEquals(Destination.Home(ngozi), route(SessionState.SignedIn(ngozi), null))
    }

    @Test
    fun `backing out of a link while signed out lands on login, while signed in on home`() {
        // MainActivity clears the link code on Back; the next route() call is with null.
        assertEquals(Destination.Login(null), route(SessionState.SignedOut(), null))
        assertEquals(Destination.Home(ngozi), route(SessionState.SignedIn(ngozi), null))
    }

    @Test
    fun `a link survives the session changing underneath it`() {
        // Signed out with a link, then the user signs in: still the same link.
        assertEquals(Destination.Link("abc12345"), route(SessionState.SignedOut(), "abc12345"))
        assertEquals(Destination.Link("abc12345"), route(SessionState.SignedIn(ngozi), "abc12345"))
    }
}
