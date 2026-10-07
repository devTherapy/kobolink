package com.folusayo.kobolink.auth

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * A plain JVM test (no Android Keystore, no device needed) of the actual
 * bytes [AuthInterceptor] puts on the wire — [FakeTokenStore] stands in for
 * [EncryptedTokenStore] so this exercises the interceptor's own logic in
 * isolation.
 *
 * [server] plays the configured API; [otherServer] is any other origin the
 * shared OkHttp client might be pointed at (a redirect target, an image CDN,
 * a future third-party call) and must never see the credential.
 */
class AuthInterceptorTest {
    private lateinit var server: MockWebServer
    private lateinit var otherServer: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        otherServer = MockWebServer()
        otherServer.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
        otherServer.shutdown()
    }

    private class FakeTokenStore(private var value: String?) : TokenStore {
        var clearCalls = 0
            private set

        override fun saveToken(token: String) {
            value = token
        }

        override fun token(): String? = value

        override fun clear() {
            value = null
            clearCalls += 1
        }
    }

    private fun clientFor(store: TokenStore, onSessionExpired: () -> Unit = {}) = OkHttpClient.Builder()
        .addInterceptor(AuthInterceptor(store, server.url("/"), onSessionExpired))
        .build()

    @Test
    fun `attaches Authorization Bearer when a token is stored`() {
        server.enqueue(MockResponse().setResponseCode(200))
        val client = clientFor(FakeTokenStore("a-fake-session-token"))

        client.newCall(Request.Builder().url(server.url("/api/wallet")).build()).execute().close()

        val recorded = server.takeRequest()
        assertEquals("Bearer a-fake-session-token", recorded.getHeader("Authorization"))
    }

    @Test
    fun `adds no Authorization header when signed out`() {
        server.enqueue(MockResponse().setResponseCode(200))
        val client = clientFor(FakeTokenStore(null))

        client.newCall(Request.Builder().url(server.url("/api/links/abc12345/public")).build()).execute().close()

        val recorded = server.takeRequest()
        assertNull(recorded.getHeader("Authorization"))
    }

    @Test
    fun `a token saved after construction is picked up on the next request`() {
        server.enqueue(MockResponse().setResponseCode(200))
        server.enqueue(MockResponse().setResponseCode(200))
        val store = FakeTokenStore(null)
        val client = clientFor(store)

        client.newCall(Request.Builder().url(server.url("/api/auth/me")).build()).execute().close()
        assertNull(server.takeRequest().getHeader("Authorization"))

        store.saveToken("issued-after-login")
        client.newCall(Request.Builder().url(server.url("/api/auth/me")).build()).execute().close()
        assertEquals("Bearer issued-after-login", server.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun `never sends the token to a host other than the configured API`() {
        otherServer.enqueue(MockResponse().setResponseCode(200))
        val client = clientFor(FakeTokenStore("secret-session-token"))

        client.newCall(Request.Builder().url(otherServer.url("/anything")).build()).execute().close()

        assertNull(otherServer.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun `a 401 to an authenticated request clears the token and signals expiry`() {
        server.enqueue(MockResponse().setResponseCode(401))
        val store = FakeTokenStore("revoked-token")
        var expiredSignals = 0
        val client = clientFor(store) { expiredSignals += 1 }

        val response = client.newCall(Request.Builder().url(server.url("/api/wallet")).build()).execute()
        response.close()

        assertEquals(401, response.code)
        assertNull(store.token())
        assertEquals(1, expiredSignals)
    }

    @Test
    fun `a 401 to an unauthenticated request does not signal expiry`() {
        server.enqueue(MockResponse().setResponseCode(401))
        val store = FakeTokenStore(null)
        var expiredSignals = 0
        val client = clientFor(store) { expiredSignals += 1 }

        // e.g. a wrong-password login: no token was attached, so nothing was "rejected".
        client.newCall(Request.Builder().url(server.url("/api/auth/login")).build()).execute().close()

        assertEquals(0, expiredSignals)
        assertEquals(0, store.clearCalls)
    }

    @Test
    fun `a 401 from another origin does not clear the token or signal expiry`() {
        otherServer.enqueue(MockResponse().setResponseCode(401))
        val store = FakeTokenStore("still-valid-token")
        var expiredSignals = 0
        val client = clientFor(store) { expiredSignals += 1 }

        client.newCall(Request.Builder().url(otherServer.url("/anything")).build()).execute().close()

        assertEquals("still-valid-token", store.token())
        assertEquals(0, expiredSignals)
    }

    @Test
    fun `a late 401 for an old token does not clear a newer token`() {
        val store = FakeTokenStore("old-token")
        // Another sign-in lands while this request is in flight: by the time
        // the server's 401 comes back, the store holds a different token.
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                store.saveToken("new-token")
                return MockResponse().setResponseCode(401)
            }
        }
        var expiredSignals = 0
        val client = clientFor(store) { expiredSignals += 1 }

        client.newCall(Request.Builder().url(server.url("/api/wallet")).build()).execute().close()

        assertEquals("new-token", store.token())
        assertEquals(0, expiredSignals)
    }
}
