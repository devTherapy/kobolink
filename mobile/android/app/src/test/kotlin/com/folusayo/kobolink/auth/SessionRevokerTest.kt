package com.folusayo.kobolink.auth

import com.folusayo.kobolink.generated.api.infrastructure.Serializer
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The revoke that follows a sign-out carries the token that was just removed from the store, explicitly, and nothing
 * the store holds now: the store is empty (or holds someone else's token) by the time it goes out.
 */
class SessionRevokerTest {

    @Test
    fun `it posts to the logout endpoint with the token it was given, and not the stored one`() = runTest {
        val server = MockWebServer().apply { start() }
        try {
            server.enqueue(MockResponse().setResponseCode(204))
            val store = RecordingTokenStore().also { it.saveToken("token-of-b") }
            // The shared client has the AuthInterceptor, which would attach B's token: the revoker must drop it.
            val shared = OkHttpClient.Builder().addInterceptor(AuthInterceptor(store, server.url("/"))).build()

            SessionRevoker(shared, server.url("/")).revoke("token-of-a")

            val recorded = server.takeRequest()
            assertEquals("POST", recorded.method)
            assertEquals("/api/auth/logout", recorded.path)
            assertEquals("Bearer token-of-a", recorded.getHeader("Authorization"))
            assertEquals("and it never touches the store", 0, store.clearCalls)
            assertEquals("token-of-b", store.token())
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `a 401 to the revoke does not clear or expire anything`() = runTest {
        val server = MockWebServer().apply { start() }
        try {
            server.enqueue(MockResponse().setResponseCode(401))
            val store = RecordingTokenStore().also { it.saveToken("token-of-b") }
            var expired = false
            val shared = OkHttpClient.Builder().addInterceptor(AuthInterceptor(store, server.url("/")) { expired = true }).build()

            SessionRevoker(shared, server.url("/")).revoke("token-of-a")

            assertEquals(false, expired)
            assertEquals("token-of-b", store.token())
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `logout through the repository clears first and hands the revoker the token it read before clearing`() = runTest {
        val store = RecordingTokenStore().also { it.saveToken("token-of-a") }
        var revokedWith: String? = null
        var storedWhileRevoking: String? = "not looked at"
        val repo = AuthRepository(FakeAuthApi(), store, Serializer.kotlinxSerializationJson) { token ->
            revokedWith = token
            storedWhileRevoking = store.token()
        }

        repo.logout()

        assertEquals("token-of-a", revokedWith)
        assertNull(storedWhileRevoking)
        assertNull(store.token())
    }

    @Test
    fun `a revoke that fails on the network still leaves the device signed out, and with nothing stored nothing is revoked`() = runTest {
        val store = RecordingTokenStore().also { it.saveToken("token-of-a") }
        val failing = AuthRepository(FakeAuthApi(), store, Serializer.kotlinxSerializationJson) { throw java.io.IOException("down") }
        failing.logout()
        assertNull(store.token())

        var revoked = false
        val empty = AuthRepository(FakeAuthApi(), RecordingTokenStore(), Serializer.kotlinxSerializationJson) { revoked = true }
        empty.logout()
        assertTrue(!revoked)
    }

    @Test
    fun `a clear that fails is reported after the revoke was still tried`() = runTest {
        val store = RecordingTokenStore(clearFailure = java.io.IOException("disk")).also { it.saveToken("token-of-a") }
        var revoked = false
        val repo = AuthRepository(FakeAuthApi(), store, Serializer.kotlinxSerializationJson) { revoked = true }

        val thrown = runCatching { repo.logout() }.exceptionOrNull()

        assertTrue(thrown is java.io.IOException)
        assertTrue(revoked)
    }
}
