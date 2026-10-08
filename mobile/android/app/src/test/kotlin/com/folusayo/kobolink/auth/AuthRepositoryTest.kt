package com.folusayo.kobolink.auth

import com.folusayo.kobolink.generated.api.infrastructure.Serializer
import java.io.IOException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

/**
 * [AuthRepository] is the only code that decides "we are now signed in" or
 * "we are now signed out" — this proves both directions without a network or
 * an Android Keystore: a scriptable [FakeAuthApi] stands in for the real
 * Retrofit interface, and [RecordingTokenStore] stands in for
 * [EncryptedTokenStore] (see AuthFakes.kt).
 *
 * `AuthResponse.user` and `MeResponse.user` are, per [AuthenticatedUser]'s
 * doc comment, two different generated classes (`AuthResponseUser`,
 * `MeResponseUser`) for the same conceptual `User` — these tests construct
 * both to prove [AuthRepository] normalizes either into one
 * [AuthenticatedUser] shape.
 */
class AuthRepositoryTest {

    private val json = Serializer.kotlinxSerializationJson

    @Test
    fun `login stores the returned token and resolves the user`() = runTest {
        val tokenStore = RecordingTokenStore()
        val repo = AuthRepository(FakeAuthApi(loginResponse = loginSuccess()), tokenStore, json)

        val result = repo.login("ngozi@example.com", "correct horse battery staple")

        assertTrue(result.isSuccess)
        assertEquals(ngozi, result.getOrNull())
        assertEquals("a-real-looking-session-token-value", tokenStore.saved)
        assertTrue(repo.isSignedIn)
    }

    @Test
    fun `login failure never writes a token`() = runTest {
        val tokenStore = RecordingTokenStore()
        val api = FakeAuthApi(
            loginResponse = Response.error(401, jsonErrorBody("unauthenticated", "Incorrect email or password.")),
        )
        val repo = AuthRepository(api, tokenStore, json)

        val result = repo.login("ngozi@example.com", "wrong-password")

        assertTrue(result.isFailure)
        assertEquals("Incorrect email or password.", result.exceptionOrNull()?.message)
        assertNull(tokenStore.saved)
        assertTrue(!repo.isSignedIn)
    }

    @Test
    fun `login returns a failure instead of throwing when secure storage rejects the token`() = runTest {
        // A Keystore/encryption failure surfaces from EncryptedSharedPreferences as a
        // SecurityException (or another runtime exception). It must not escape login():
        // LoginScreen calls it from a bare scope.launch, where it would crash the app.
        val tokenStore = RecordingTokenStore(saveFailure = SecurityException("Keystore key invalidated"))
        val repo = AuthRepository(FakeAuthApi(loginResponse = loginSuccess()), tokenStore, json)

        val result = repo.login("ngozi@example.com", "correct horse battery staple")

        assertTrue("login must return Result.failure, not throw", result.isFailure)
        val message = result.exceptionOrNull()?.message.orEmpty()
        assertTrue("message should say the user was not signed in: $message", message.contains("not signed in"))
        assertTrue("message should name secure storage as what failed: $message", message.contains("secure storage"))
        assertNull("nothing may be stored in plain form as a fallback", tokenStore.saved)
        assertTrue(!repo.isSignedIn)
    }

    @Test
    fun `a storage IOException is not reported as a network problem`() = runTest {
        val tokenStore = RecordingTokenStore(saveFailure = IOException("disk full"))
        val repo = AuthRepository(FakeAuthApi(loginResponse = loginSuccess()), tokenStore, json)

        val message = repo.login("ngozi@example.com", "pw").exceptionOrNull()?.message.orEmpty()

        assertTrue("should not blame the API connection: $message", !message.contains("reach the API"))
        assertTrue(message.contains("not signed in"))
    }

    @Test
    fun `currentUser resolves the MeResponse shape into the same AuthenticatedUser type as login`() = runTest {
        val tokenStore = RecordingTokenStore()
        tokenStore.saveToken("already-signed-in-token")
        val repo = AuthRepository(FakeAuthApi(meResponse = meSuccess()), tokenStore, json)

        val result = repo.currentUser()

        assertTrue(result.isSuccess)
        assertEquals(ngozi, result.getOrNull())
    }

    @Test
    fun `currentUser exposes 401 as unauthorized`() = runTest {
        val api = FakeAuthApi(meResponse = Response.error(401, jsonErrorBody("unauthenticated", "Session expired.")))
        val repo = AuthRepository(api, RecordingTokenStore(), json)

        val failure = repo.currentUser().exceptionOrNull() as? AuthException

        assertNotNull("failure must be an AuthException so callers can read the status", failure)
        assertEquals(401, failure!!.httpStatus)
        assertTrue(failure.isUnauthorized)
    }

    @Test
    fun `currentUser exposes a 5xx without calling it unauthorized`() = runTest {
        val api = FakeAuthApi(meResponse = Response.error(503, jsonErrorBody("unavailable", "Try again soon.")))
        val repo = AuthRepository(api, RecordingTokenStore(), json)

        val failure = repo.currentUser().exceptionOrNull() as? AuthException

        assertNotNull(failure)
        assertEquals(503, failure!!.httpStatus)
        assertTrue(!failure.isUnauthorized)
    }

    @Test
    fun `currentUser reports a network failure with no status`() = runTest {
        val api = FakeAuthApi(meThrows = IOException("no network"))
        val repo = AuthRepository(api, RecordingTokenStore(), json)

        val failure = repo.currentUser().exceptionOrNull() as? AuthException

        assertNotNull(failure)
        assertNull(failure!!.httpStatus)
        assertTrue(!failure.isUnauthorized)
    }

    @Test
    fun `logout clears the token even when the server call fails`() = runTest {
        val tokenStore = RecordingTokenStore()
        tokenStore.saveToken("token-to-be-cleared")
        val api = FakeAuthApi(logoutThrows = IOException("no network"))
        val repo = AuthRepository(api, tokenStore, json)

        repo.logout()

        assertTrue(api.logoutCalled)
        assertEquals(1, tokenStore.clearCalls)
        assertNull(tokenStore.saved)
        assertTrue(!repo.isSignedIn)
    }

    @Test
    fun `(red) logout clears the local token BEFORE the revoke goes over the network`() = runTest {
        val tokenStore = RecordingTokenStore()
        tokenStore.saveToken("token-of-a")
        val api = FakeAuthApi()
        var storedWhileRevoking: String? = "not looked at"
        api.onLogout = { storedWhileRevoking = tokenStore.token() }
        val repo = AuthRepository(api, tokenStore, json)

        repo.logout()

        // If the process died while the revoke was in the air, the next launch must not sign A back in.
        assertNull(storedWhileRevoking)
    }

    @Test
    fun `(red) a sign-in as B while A's revoke is in the air is not wiped by A's late clear`() = runTest {
        val tokenStore = RecordingTokenStore()
        tokenStore.saveToken("token-of-a")
        val api = FakeAuthApi()
        api.onLogout = { tokenStore.saveToken("token-of-b") }
        val repo = AuthRepository(api, tokenStore, json)

        repo.logout()

        assertEquals("token-of-b", tokenStore.token())
    }

    @Test
    fun `forgetLocalSession clears without calling the API`() = runTest {
        val tokenStore = RecordingTokenStore()
        tokenStore.saveToken("stale-token")
        val api = FakeAuthApi()
        val repo = AuthRepository(api, tokenStore, json)

        repo.forgetLocalSession()

        assertEquals(1, tokenStore.clearCalls)
        assertNull(tokenStore.saved)
        assertTrue(!api.logoutCalled)
    }
}
