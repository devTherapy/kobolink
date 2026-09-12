package com.folusayo.kobolink.auth

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
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
 */
class AuthInterceptorTest {
    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private class FakeTokenStore(private var value: String?) : TokenStore {
        override fun saveToken(token: String) {
            value = token
        }

        override fun token(): String? = value

        override fun clear() {
            value = null
        }
    }

    @Test
    fun `attaches Authorization Bearer when a token is stored`() {
        server.enqueue(MockResponse().setResponseCode(200))
        val client = OkHttpClient.Builder()
            .addInterceptor(AuthInterceptor(FakeTokenStore("a-fake-session-token")))
            .build()

        client.newCall(Request.Builder().url(server.url("/api/wallet")).build()).execute().close()

        val recorded = server.takeRequest()
        assertEquals("Bearer a-fake-session-token", recorded.getHeader("Authorization"))
    }

    @Test
    fun `adds no Authorization header when signed out`() {
        server.enqueue(MockResponse().setResponseCode(200))
        val client = OkHttpClient.Builder()
            .addInterceptor(AuthInterceptor(FakeTokenStore(null)))
            .build()

        client.newCall(Request.Builder().url(server.url("/api/links/abc12345/public")).build()).execute().close()

        val recorded = server.takeRequest()
        assertNull(recorded.getHeader("Authorization"))
    }

    @Test
    fun `a token saved after construction is picked up on the next request`() {
        server.enqueue(MockResponse().setResponseCode(200))
        server.enqueue(MockResponse().setResponseCode(200))
        val store = FakeTokenStore(null)
        val client = OkHttpClient.Builder()
            .addInterceptor(AuthInterceptor(store))
            .build()

        client.newCall(Request.Builder().url(server.url("/api/auth/me")).build()).execute().close()
        assertNull(server.takeRequest().getHeader("Authorization"))

        store.saveToken("issued-after-login")
        client.newCall(Request.Builder().url(server.url("/api/auth/me")).build()).execute().close()
        assertEquals("Bearer issued-after-login", server.takeRequest().getHeader("Authorization"))
    }
}
