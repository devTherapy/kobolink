package com.folusayo.kobolink.auth

import com.folusayo.kobolink.checkout.AttemptOwner
import com.folusayo.kobolink.generated.api.infrastructure.Serializer
import java.io.IOException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

/**
 * What the session tells the rest of the app, and the gate in front of an explicit sign-out. The Kotlin twin of iOS's
 * `SessionChangeTests`: `Resolved` for the check confirming the stored token, `SignedIn` for credentials,
 * `SignedOutByChoice` for the person's own sign-out, `Ended` for a 401. Only the first three can forget anything; the
 * fourth must not.
 */
class SessionChangeTest {

    private val json = Serializer.kotlinxSerializationJson

    private fun controllerWith(api: FakeAuthApi, store: RecordingTokenStore = RecordingTokenStore()) =
        SessionController(AuthRepository(api, store, json)) to store

    private fun signedInStore() = RecordingTokenStore().also { it.saveToken("valid-token") }

    private fun SessionController.record(): MutableList<SessionChange> {
        val seen = mutableListOf<SessionChange>()
        onChange = { seen += it }
        return seen
    }

    @Test
    fun `the check confirming the stored token reports Resolved with the user`() = runTest {
        val (controller, _) = controllerWith(FakeAuthApi(meResponse = meSuccess()), signedInStore())
        val seen = controller.record()

        controller.resolve()

        assertEquals(listOf<SessionChange>(SessionChange.Resolved(ngozi)), seen)
    }

    @Test
    fun `a 401 from the check reports Ended, and a failure to reach the server reports nothing`() = runTest {
        val (rejected, _) = controllerWith(
            FakeAuthApi(meResponse = Response.error(401, jsonErrorBody("unauthenticated", "Session expired."))),
            signedInStore(),
        )
        val ended = rejected.record()
        rejected.resolve()
        assertEquals(listOf<SessionChange>(SessionChange.Ended), ended)

        val (offline, _) = controllerWith(FakeAuthApi(meThrows = IOException("down")), signedInStore())
        val nothing = offline.record()
        offline.resolve()
        assertTrue(nothing.isEmpty())
    }

    @Test
    fun `a sign-in with credentials reports SignedIn`() = runTest {
        val (controller, _) = controllerWith(FakeAuthApi(loginResponse = loginSuccess()))
        val seen = controller.record()
        controller.resolve()

        controller.login("ngozi@example.com", "pw")

        assertEquals(listOf<SessionChange>(SessionChange.SignedIn(ngozi)), seen)
    }

    @Test
    fun `a failed sign-in reports nothing`() = runTest {
        val api = FakeAuthApi(loginResponse = Response.error(401, jsonErrorBody("unauthenticated", "Wrong password.")))
        val (controller, _) = controllerWith(api)
        val seen = controller.record()
        controller.resolve()

        controller.login("ngozi@example.com", "pw")

        assertTrue(seen.isEmpty())
    }

    @Test
    fun `an expiry while signed in reports Ended and an expiry while signed out reports nothing`() = runTest {
        val (controller, _) = controllerWith(FakeAuthApi(meResponse = meSuccess()), signedInStore())
        controller.resolve()
        val seen = controller.record()

        controller.onSessionExpired()
        controller.onSessionExpired()

        assertEquals(listOf<SessionChange>(SessionChange.Ended), seen)
    }

    @Test
    fun `an explicit sign-out reports SignedOutByChoice BEFORE the network is touched`() = runTest {
        val api = FakeAuthApi(meResponse = meSuccess())
        val (controller, store) = controllerWith(api, signedInStore())
        controller.resolve()
        var revokedWhenTold: Boolean? = null
        var tokenWhenTold: String? = null
        controller.onChange = {
            revokedWhenTold = api.logoutCalled
            tokenWhenTold = store.token()
        }

        controller.logout()

        assertEquals("the person's attempts are forgotten before the revoke is sent", false, revokedWhenTold)
        assertEquals("and before the token goes", "valid-token", tokenWhenTold)
        assertTrue(api.logoutCalled)
        assertNull(store.token())
        assertEquals(SessionState.SignedOut(), controller.state.value)
    }

    @Test
    fun `(red) while the revoke is in the air the person is already signed out, so a late payment is a payer's and not in the obligation`() = runTest {
        val api = FakeAuthApi(meResponse = meSuccess())
        val (controller, _) = controllerWith(api, signedInStore())
        controller.resolve()
        var stateDuring: SessionState? = null
        var ownerDuring: AttemptOwner? = null
        api.onLogout = {
            stateDuring = controller.state.value
            ownerDuring = controller.attemptOwner
        }

        controller.logout()

        assertEquals(SessionState.SignedOut(), stateDuring)
        assertEquals(AttemptOwner.Payer, ownerDuring)
    }

    // ---- the gate ---------------------------------------------------------------------------------------------

    @Test
    fun `a sign-out the checkout cannot make safe does not happen, the token is kept and nothing is revoked`() = runTest {
        val api = FakeAuthApi(meResponse = meSuccess())
        val (controller, store) = controllerWith(api, signedInStore())
        controller.resolve()
        val seen = controller.record()
        controller.willSignOut = { false }

        controller.logout()

        assertTrue(controller.state.value is SessionState.SignedIn)
        assertEquals("valid-token", store.token())
        assertEquals(0, store.clearCalls)
        assertFalse(api.logoutCalled)
        assertTrue("and nothing was forgotten", seen.isEmpty())
        assertTrue(controller.signOutBlocked.value)
    }

    @Test
    fun `the person acknowledges the refusal and tries again, and then it goes through`() = runTest {
        val api = FakeAuthApi(meResponse = meSuccess())
        val (controller, store) = controllerWith(api, signedInStore())
        controller.resolve()
        var safe = false
        controller.willSignOut = { safe }

        controller.logout()
        assertTrue(controller.signOutBlocked.value)
        controller.acknowledgeSignOutBlocked()
        assertFalse(controller.signOutBlocked.value)

        safe = true
        controller.logout()

        assertEquals(SessionState.SignedOut(), controller.state.value)
        assertNull(store.token())
        assertFalse(controller.signOutBlocked.value)
    }

    @Test
    fun `a sign-out with no gate set still works`() = runTest {
        val (controller, store) = controllerWith(FakeAuthApi(meResponse = meSuccess()), signedInStore())
        controller.resolve()

        controller.logout()

        assertEquals(SessionState.SignedOut(), controller.state.value)
        assertNull(store.token())
    }

    // ---- who an attempt belongs to ---------------------------------------------------------------------------------

    @Test
    fun `with no stored session an attempt is a payer's`() = runTest {
        val (controller, _) = controllerWith(FakeAuthApi())
        controller.resolve()

        assertEquals(AttemptOwner.Payer, controller.attemptOwner)
    }

    @Test
    fun `while the session is resolving or offline an attempt belongs to a session, to nobody in particular yet`() = runTest {
        val (resolving, _) = controllerWith(FakeAuthApi(meResponse = meSuccess()), signedInStore())
        assertEquals("before the check has run", AttemptOwner.Session(null), resolving.attemptOwner)

        val (offline, _) = controllerWith(FakeAuthApi(meThrows = IOException("down")), signedInStore())
        offline.resolve()
        assertEquals(AttemptOwner.Session(null), offline.attemptOwner)
    }

    @Test
    fun `once signed in an attempt belongs to that user`() = runTest {
        val (controller, _) = controllerWith(FakeAuthApi(meResponse = meSuccess()), signedInStore())
        controller.resolve()

        assertEquals(AttemptOwner.Session(ngozi.id), controller.attemptOwner)
    }

    @Test
    fun `after an expiry or a sign-out an attempt is a payer's again`() = runTest {
        val (expired, _) = controllerWith(FakeAuthApi(meResponse = meSuccess()), signedInStore())
        expired.resolve()
        expired.onSessionExpired()
        assertEquals(AttemptOwner.Payer, expired.attemptOwner)

        val (signedOut, _) = controllerWith(FakeAuthApi(meResponse = meSuccess()), signedInStore())
        signedOut.resolve()
        signedOut.logout()
        assertEquals(AttemptOwner.Payer, signedOut.attemptOwner)
    }

    @Test
    fun `a token that cannot be read is not a payer's device`() = runTest {
        val unreadable = RecordingTokenStore(readFailure = SecurityException("Keystore unavailable"))
        val (controller, _) = controllerWith(FakeAuthApi(meResponse = meSuccess()), unreadable)
        controller.resolve()

        assertEquals(AttemptOwner.Session(null), controller.attemptOwner)
    }
}
