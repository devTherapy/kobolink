package com.folusayo.kobolink.api

import com.folusayo.kobolink.generated.api.apis.WalletApi
import com.folusayo.kobolink.generated.api.models.TopUpRequest
import com.folusayo.kobolink.generated.api.models.TransferRequest
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * What the wallet client actually puts on the wire. A fake [WalletApi] never
 * serialises, which is how "a transfer with no note is sent as `note: null`"
 * (rejected by the server: `note` is optional, not nullable, in
 * packages/contracts) went unnoticed. These run the real Retrofit +
 * kotlinx.serialization stack, built by [ApiClientProvider.newRetrofit], with
 * the wallet's [ApiClientProvider.walletJson], against a MockWebServer.
 */
class WalletRequestEncodingTest {

    private lateinit var server: MockWebServer
    private lateinit var api: WalletApi

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        api = ApiClientProvider.newRetrofit(server.url("/").toString(), OkHttpClient(), ApiClientProvider.walletJson)
            .create(WalletApi::class.java)
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private suspend fun sentBody(call: suspend () -> Unit): String {
        server.enqueue(MockResponse().setResponseCode(500))
        call()
        return server.takeRequest().body.readUtf8()
    }

    @Test
    fun `a transfer with no note sends no note key at all`() = runTest {
        val body = sentBody { api.transferMoney("key-0123456789abcdef", TransferRequest("+2348031234567", 250_000L, note = null)) }

        assertFalse("note must be omitted, not null: $body", body.contains("note"))
        assertTrue(body, body.contains(""""toPhone":"+2348031234567""""))
        assertTrue(body, body.contains(""""amountKobo":250000"""))
    }

    @Test
    fun `a transfer with a note sends it`() = runTest {
        val body = sentBody { api.transferMoney("key-0123456789abcdef", TransferRequest("+2348031234567", 250_000L, note = "rent")) }

        assertTrue(body, body.contains(""""note":"rent""""))
    }

    @Test
    fun `the idempotency key travels as the Idempotency-Key header`() = runTest {
        server.enqueue(MockResponse().setResponseCode(500))
        api.transferMoney("key-0123456789abcdef", TransferRequest("+2348031234567", 250_000L))
        assertEquals("key-0123456789abcdef", server.takeRequest().getHeader("Idempotency-Key"))
    }

    @Test
    fun `a top-up body is just the amount`() = runTest {
        val body = sentBody { api.topUpWallet("key-0123456789abcdef", TopUpRequest(100_000L)) }
        assertEquals("""{"amountKobo":100000}""", body)
    }

    @Test
    fun `a transfer is never silently re-sent after a dropped connection`() = runTest {
        // OkHttp's default retryOnConnectionFailure would write the same POST a second time on a
        // fresh connection; the first may already have posted, and the app could then report
        // "never sent". The wallet client must send each transfer at most once per call.
        val client = ApiClientProvider.walletClient(OkHttpClient())
        val walletApi = ApiClientProvider.newRetrofit(server.url("/").toString(), client, ApiClientProvider.walletJson)
            .create(WalletApi::class.java)
        // A first call leaves a pooled keep-alive connection; the server then drops it right after
        // reading the next request, which is the stale-connection case OkHttp silently retries.
        server.enqueue(MockResponse().setResponseCode(500))
        runCatching { walletApi.transferMoney("key-0123456789abcdef", TransferRequest("+2348031234567", 250_000L)) }
        val before = server.requestCount
        server.enqueue(MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AFTER_REQUEST))
        server.enqueue(MockResponse().setResponseCode(500))

        runCatching { walletApi.transferMoney("key-0123456789abcdef", TransferRequest("+2348031234567", 250_000L)) }

        assertEquals("exactly one copy of the request reached the server", before + 1, server.requestCount)
    }
}
