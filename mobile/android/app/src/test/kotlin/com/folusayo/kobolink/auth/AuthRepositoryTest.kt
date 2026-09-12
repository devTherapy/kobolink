package com.folusayo.kobolink.auth

import com.folusayo.kobolink.generated.api.apis.AuthApi
import com.folusayo.kobolink.generated.api.infrastructure.Serializer
import com.folusayo.kobolink.generated.api.models.AuthResponse
import com.folusayo.kobolink.generated.api.models.AuthResponseSession
import com.folusayo.kobolink.generated.api.models.AuthResponseUser
import com.folusayo.kobolink.generated.api.models.AuthResponseUserPhone
import com.folusayo.kobolink.generated.api.models.LoginRequest
import com.folusayo.kobolink.generated.api.models.MeResponse
import com.folusayo.kobolink.generated.api.models.MeResponseUser
import com.folusayo.kobolink.generated.api.models.RegisterRequest
import java.io.IOException
import java.time.OffsetDateTime
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

/**
 * [AuthRepository] is the only code that decides "we are now signed in" or
 * "we are now signed out" — this proves both directions without a network or
 * an Android Keystore: a scriptable [FakeAuthApi] stands in for the real
 * Retrofit interface, and [RecordingTokenStore] stands in for
 * [EncryptedTokenStore].
 *
 * `AuthResponse.user` and `MeResponse.user` are, per [AuthenticatedUser]'s
 * doc comment, two different generated classes (`AuthResponseUser`,
 * `MeResponseUser`) for the same conceptual `User` — this test constructs
 * both to prove [AuthRepository] normalizes either into one
 * [AuthenticatedUser] shape.
 */
class AuthRepositoryTest {

    private val authResponseUser = AuthResponseUser(
        id = "user_123",
        role = AuthResponseUser.Role.merchant,
        email = "ngozi@example.com",
        phone = AuthResponseUserPhone(),
        displayName = "Ngozi",
        createdAt = OffsetDateTime.now(),
    )

    private val meResponseUser = MeResponseUser(
        id = "user_123",
        role = MeResponseUser.Role.merchant,
        email = "ngozi@example.com",
        phone = AuthResponseUserPhone(),
        displayName = "Ngozi",
        createdAt = OffsetDateTime.now(),
    )

    private class RecordingTokenStore : TokenStore {
        var saved: String? = null
            private set
        var clearCalls = 0
            private set

        override fun saveToken(token: String) {
            saved = token
        }

        override fun token(): String? = saved

        override fun clear() {
            saved = null
            clearCalls += 1
        }
    }

    private class FakeAuthApi(
        private val loginResponse: Response<AuthResponse>? = null,
        private val meResponse: Response<MeResponse>? = null,
        private val logoutThrows: Exception? = null,
    ) : AuthApi {
        var logoutCalled = false

        override suspend fun getMe(): Response<MeResponse> = meResponse ?: error("no getMe() stub configured")

        override suspend fun login(loginRequest: LoginRequest): Response<AuthResponse> =
            loginResponse ?: error("no login() stub configured")

        override suspend fun logout(): Response<Unit> {
            logoutCalled = true
            logoutThrows?.let { throw it }
            return Response.success(204, Unit)
        }

        override suspend fun registerUser(registerRequest: RegisterRequest): Response<AuthResponse> =
            error("not used by these tests")
    }

    private fun jsonErrorBody(code: String, message: String) = """{"code":"$code","message":"$message"}"""
        .toResponseBody("application/json".toMediaType())

    @Test
    fun `login stores the returned token and resolves the user`() = runTest {
        val tokenStore = RecordingTokenStore()
        val authResponse = AuthResponse(
            user = authResponseUser,
            session = AuthResponseSession(id = "sess_1", expiresAt = OffsetDateTime.now().plusDays(30)),
            token = "a-real-looking-session-token-value",
        )
        val api = FakeAuthApi(loginResponse = Response.success(authResponse))
        val repo = AuthRepository(api, tokenStore, Serializer.kotlinxSerializationJson)

        val result = repo.login("ngozi@example.com", "correct horse battery staple")

        assertTrue(result.isSuccess)
        assertEquals(AuthenticatedUser(id = "user_123", email = "ngozi@example.com", displayName = "Ngozi"), result.getOrNull())
        assertEquals("a-real-looking-session-token-value", tokenStore.saved)
        assertTrue(repo.isSignedIn)
    }

    @Test
    fun `login failure never writes a token`() = runTest {
        val tokenStore = RecordingTokenStore()
        val api = FakeAuthApi(
            loginResponse = Response.error(401, jsonErrorBody("unauthenticated", "Incorrect email or password.")),
        )
        val repo = AuthRepository(api, tokenStore, Serializer.kotlinxSerializationJson)

        val result = repo.login("ngozi@example.com", "wrong-password")

        assertTrue(result.isFailure)
        assertEquals("Incorrect email or password.", result.exceptionOrNull()?.message)
        assertNull(tokenStore.saved)
        assertTrue(!repo.isSignedIn)
    }

    @Test
    fun `currentUser resolves the MeResponse shape into the same AuthenticatedUser type as login`() = runTest {
        val tokenStore = RecordingTokenStore()
        tokenStore.saveToken("already-signed-in-token")
        val api = FakeAuthApi(meResponse = Response.success(MeResponse(user = meResponseUser)))
        val repo = AuthRepository(api, tokenStore, Serializer.kotlinxSerializationJson)

        val result = repo.currentUser()

        assertTrue(result.isSuccess)
        assertEquals(AuthenticatedUser(id = "user_123", email = "ngozi@example.com", displayName = "Ngozi"), result.getOrNull())
    }

    @Test
    fun `logout clears the token even when the server call fails`() = runTest {
        val tokenStore = RecordingTokenStore()
        tokenStore.saveToken("token-to-be-cleared")
        val api = FakeAuthApi(logoutThrows = IOException("no network"))
        val repo = AuthRepository(api, tokenStore, Serializer.kotlinxSerializationJson)

        repo.logout()

        assertTrue(api.logoutCalled)
        assertEquals(1, tokenStore.clearCalls)
        assertNull(tokenStore.saved)
        assertTrue(!repo.isSignedIn)
    }

    @Test
    fun `forgetLocalSession clears without calling the API`() = runTest {
        val tokenStore = RecordingTokenStore()
        tokenStore.saveToken("stale-token")
        val api = FakeAuthApi()
        val repo = AuthRepository(api, tokenStore, Serializer.kotlinxSerializationJson)

        repo.forgetLocalSession()

        assertEquals(1, tokenStore.clearCalls)
        assertNull(tokenStore.saved)
        assertTrue(!api.logoutCalled)
    }
}
