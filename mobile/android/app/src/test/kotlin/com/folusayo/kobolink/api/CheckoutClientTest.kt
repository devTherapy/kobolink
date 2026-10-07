package com.folusayo.kobolink.api

import com.folusayo.kobolink.checkout.ApiCheckoutGateway
import com.folusayo.kobolink.checkout.FailureKind
import com.folusayo.kobolink.checkout.InitializeOutcome
import com.folusayo.kobolink.checkout.InitializeRequest
import com.folusayo.kobolink.generated.api.apis.CheckoutApi
import com.folusayo.kobolink.generated.api.apis.LinksApi
import com.folusayo.kobolink.generated.api.infrastructure.Serializer
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import retrofit2.Retrofit

/**
 * M3 review (d). `POST /api/checkout/initialize` creates a pending checkout. OkHttp's default
 * `retryOnConnectionFailure` re-writes a POST on a fresh connection when the first one dies after the request was
 * sent; the first copy may already have been stored, and the app would then report a failure for a checkout that
 * exists. A payment is sent at most once per call; any retry is the app's own, under the same idempotency key
 * (M5 does the same for the wallet: `ApiClientProvider.walletClient`).
 */
class CheckoutClientTest {

    private lateinit var server: MockWebServer
    private val json = Serializer.kotlinxSerializationJson
    private val request = InitializeRequest("7hK2mQ9x", 1_500_000, "Tunde Bello", "tunde@example.com")

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun gatewayOver(client: OkHttpClient): ApiCheckoutGateway {
        val retrofit = Retrofit.Builder()
            .baseUrl(server.url("/"))
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
        return ApiCheckoutGateway(retrofit.create(LinksApi::class.java), retrofit.create(CheckoutApi::class.java), json)
    }

    /**
     * A first call leaves a pooled keep-alive connection; the server then drops it right after reading the next
     * request, which is the stale-connection case OkHttp silently retries. Returns how many copies of the second
     * request reached the server.
     */
    private suspend fun copiesReceivedAfterADroppedConnection(gateway: ApiCheckoutGateway): Pair<Int, InitializeOutcome> {
        server.enqueue(MockResponse().setResponseCode(500))
        gateway.initialize(request, "attempt-key-0-0123456789")
        val before = server.requestCount
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        server.enqueue(MockResponse().setResponseCode(500))
        val outcome = gateway.initialize(request, "attempt-key-0-0123456789")
        return (server.requestCount - before) to outcome
    }

    @Test
    fun `a payment request is never silently re-sent after a dropped connection`() = runTest {
        val (copies, outcome) = copiesReceivedAfterADroppedConnection(gatewayOver(ApiClientProvider.checkoutClient(OkHttpClient())))

        assertEquals("exactly one copy of the request reached the server", 1, copies)
        // The outcome is unknown to the app, so it is a failure the payer can retry under the same key.
        assertEquals(InitializeOutcome.Failed(FailureKind.Network), outcome)
    }

    @Test
    fun `the default client does re-send, which is the hazard the checkout client removes`() = runTest {
        val (copies, _) = copiesReceivedAfterADroppedConnection(gatewayOver(OkHttpClient()))

        assertTrue("expected OkHttp's default to re-send the POST, got $copies copies", copies > 1)
    }

    @Test
    fun `the checkout client keeps the base client's other settings`() {
        val base = OkHttpClient.Builder().callTimeout(java.time.Duration.ofSeconds(7)).build()
        val client = ApiClientProvider.checkoutClient(base)

        assertEquals(base.callTimeoutMillis, client.callTimeoutMillis)
        assertEquals(false, client.retryOnConnectionFailure)
        assertEquals(true, base.retryOnConnectionFailure)
    }
}
