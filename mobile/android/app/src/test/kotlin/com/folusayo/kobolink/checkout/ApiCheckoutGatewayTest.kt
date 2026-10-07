package com.folusayo.kobolink.checkout

import com.folusayo.kobolink.generated.api.apis.CheckoutApi
import com.folusayo.kobolink.generated.api.apis.LinksApi
import com.folusayo.kobolink.generated.api.infrastructure.Serializer
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.time.OffsetDateTime
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import retrofit2.Retrofit

/**
 * [ApiCheckoutGateway] against a real HTTP server and the real generated Retrofit interfaces, built the way
 * `ApiClientProvider` builds them. What is under test is the part no fake can prove: the bytes on the wire
 * (path, `Idempotency-Key` header, JSON body) and how every kind of answer is classified.
 */
class ApiCheckoutGatewayTest {
    private lateinit var server: MockWebServer
    private lateinit var gateway: ApiCheckoutGateway

    private val json = Serializer.kotlinxSerializationJson

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        val retrofit = Retrofit.Builder()
            .baseUrl(server.url("/"))
            .client(OkHttpClient())
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
        gateway = ApiCheckoutGateway(retrofit.create(LinksApi::class.java), retrofit.create(CheckoutApi::class.java), json)
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun publicLinkJson(
        state: String = "payable",
        amountKobo: String = "1500000",
        description: String = "null",
        expiresAt: String = "null",
    ) = """
        {"state":"$state","link":{"code":"7hK2mQ9x","merchantName":"Ada's Bakery","title":"Birthday cake",
        "description":$description,"amountKobo":$amountKobo,"currency":"NGN","isReusable":false,"expiresAt":$expiresAt}}
    """.trimIndent()

    private fun respond(status: Int, body: String, contentType: String = "application/json") {
        server.enqueue(MockResponse().setResponseCode(status).setHeader("Content-Type", contentType).setBody(body))
    }

    private fun apiError(code: String, message: String, extra: String = "") =
        """{"code":"$code","message":"$message"$extra}"""

    // ---- lookup ---------------------------------------------------------------------------

    @Test
    fun `lookup reads the public link without credentials or an idempotency key`() = runTest {
        respond(200, publicLinkJson(description = "\"Two tiers, vanilla.\""))

        val outcome = gateway.lookup("7hK2mQ9x")

        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/api/links/7hK2mQ9x/public", request.path)
        assertNull(request.getHeader("Idempotency-Key"))
        assertEquals(
            LookupOutcome.Found(
                CheckoutLink("7hK2mQ9x", "Ada's Bakery", "Birthday cake", "Two tiers, vanilla.", 1_500_000, false, null),
                LinkAvailability.Payable,
            ),
            outcome,
        )
    }

    @Test
    fun `lookup maps every public state, including the hyphenated one`() = runTest {
        val expected = mapOf(
            "payable" to LinkAvailability.Payable,
            "disabled" to LinkAvailability.Disabled,
            "expired" to LinkAvailability.Expired,
            "already-paid" to LinkAvailability.AlreadyPaid,
        )
        for ((wire, availability) in expected) {
            respond(200, publicLinkJson(state = wire))
            assertEquals("state $wire", availability, (gateway.lookup("7hK2mQ9x") as LookupOutcome.Found).availability)
        }
    }

    @Test
    fun `lookup keeps an open amount as null and parses the expiry`() = runTest {
        respond(200, publicLinkJson(amountKobo = "null", expiresAt = "\"2030-01-01T10:15:30+01:00\""))

        val link = (gateway.lookup("7hK2mQ9x") as LookupOutcome.Found).link

        assertNull(link.amountKobo)
        assertEquals(OffsetDateTime.parse("2030-01-01T10:15:30+01:00"), link.expiresAt)
    }

    @Test
    fun `a blank description is no description`() = runTest {
        respond(200, publicLinkJson(description = "\"   \""))
        assertNull((gateway.lookup("7hK2mQ9x") as LookupOutcome.Found).link.description)
    }

    @Test
    fun `a 404 not_found is not found`() = runTest {
        respond(404, apiError("not_found", "Link not found."))
        assertEquals(LookupOutcome.NotFound, gateway.lookup("7hK2mQ9x"))
    }

    @Test
    fun `lookup classifies what it cannot answer`() = runTest {
        respond(500, apiError("internal", "Something went wrong."))
        assertEquals(LookupOutcome.Failed(FailureKind.Server), gateway.lookup("7hK2mQ9x"))

        respond(429, apiError("rate_limited", "Slow down."))
        assertEquals(LookupOutcome.Failed(FailureKind.RateLimited), gateway.lookup("7hK2mQ9x"))

        // A proxy's HTML error page is not an ApiError. It is still a server-side failure, not "not found".
        respond(502, "<html>Bad gateway</html>", contentType = "text/html")
        assertEquals(LookupOutcome.Failed(FailureKind.Server), gateway.lookup("7hK2mQ9x"))

        // A 404 that is not an ApiError is a proxy or a wrong base URL talking, not the API saying this link is unknown.
        respond(404, "<html>Not here</html>", contentType = "text/html")
        assertEquals(LookupOutcome.Failed(FailureKind.Server), gateway.lookup("7hK2mQ9x"))

        respond(200, """{"state":"payable"}""") // a 2xx the generated model cannot read
        assertEquals(LookupOutcome.Failed(FailureKind.Unreadable), gateway.lookup("7hK2mQ9x"))

        respond(200, publicLinkJson(expiresAt = "\"not a date\""))
        assertEquals(LookupOutcome.Failed(FailureKind.Unreadable), gateway.lookup("7hK2mQ9x"))
    }

    @Test
    fun `a dropped connection is a network failure`() = runTest {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        assertEquals(LookupOutcome.Failed(FailureKind.Network), gateway.lookup("7hK2mQ9x"))

        server.shutdown()
        assertEquals(LookupOutcome.Failed(FailureKind.Network), gateway.lookup("7hK2mQ9x"))
    }

    // ---- initialize -----------------------------------------------------------------------

    private val request = InitializeRequest("7hK2mQ9x", 1_500_000, "Tunde Bello", "tunde@example.com")
    private val key = "attempt-key-0-0123456789"

    private fun initializedJson(reference: String = "kbl_abcdefghjk") = """
        {"reference":"$reference","code":"7hK2mQ9x","amountKobo":1500000,"currency":"NGN","status":"pending","createdAt":"2030-01-01T10:15:30+01:00"}
    """.trimIndent()

    @Test
    fun `initialize sends the key as a header and the request as the body, and returns the reference`() = runTest {
        respond(201, initializedJson())

        val outcome = gateway.initialize(request, key)

        val recorded = server.takeRequest()
        assertEquals("POST", recorded.method)
        assertEquals("/api/checkout/initialize", recorded.path)
        assertEquals(key, recorded.getHeader("Idempotency-Key"))
        val body = json.parseToJsonElement(recorded.body.readUtf8()).toString()
        assertEquals(
            """{"code":"7hK2mQ9x","amountKobo":1500000,"payerName":"Tunde Bello","payerEmail":"tunde@example.com"}""",
            body,
        )
        assertEquals(InitializeOutcome.Started("kbl_abcdefghjk", 1_500_000), outcome)
    }

    @Test
    fun `the amount goes out as an integer number of kobo`() = runTest {
        respond(201, initializedJson())
        gateway.initialize(request.copy(amountKobo = 1_850_050), key)
        val body = server.takeRequest().body.readUtf8()
        assertEquals(true, body.contains(""""amountKobo":1850050"""))
    }

    @Test
    fun `a link that stopped being payable is a rejection that names the state`() = runTest {
        respond(409, apiError("link_not_payable", "This link cannot be paid right now.", ""","state":"already-paid","moneyMoved":false"""))

        val outcome = gateway.initialize(request, key) as InitializeOutcome.Rejected

        assertEquals(RejectionKind.LinkNotPayable, outcome.rejection.kind)
        assertEquals(LinkAvailability.AlreadyPaid, outcome.rejection.availability)
        assertEquals(false, outcome.rejection.moneyMoved)
    }

    @Test
    fun `a deleted link is its own kind of refusal`() = runTest {
        respond(404, apiError("not_found", "No link with that code."))
        assertEquals(RejectionKind.NotFound, (gateway.initialize(request, key) as InitializeOutcome.Rejected).rejection.kind)
    }

    @Test
    fun `a link_not_payable that names no state has no availability`() = runTest {
        respond(409, apiError("link_not_payable", "This link cannot be paid right now."))
        assertNull((gateway.initialize(request, key) as InitializeOutcome.Rejected).rejection.availability)
    }

    @Test
    fun `an amount mismatch and a validation failure keep their field errors`() = runTest {
        respond(422, apiError("amount_mismatch", "That amount does not match this link."))
        assertEquals(RejectionKind.AmountMismatch, (gateway.initialize(request, key) as InitializeOutcome.Rejected).rejection.kind)

        respond(
            400,
            apiError("validation_failed", "Validation failed.", ""","fields":{"payerEmail":["Invalid email address"],"code":["not a valid link code"]}"""),
        )
        val rejection = (gateway.initialize(request, key) as InitializeOutcome.Rejected).rejection
        assertEquals(RejectionKind.ValidationFailed, rejection.kind)
        assertEquals(mapOf(PayerField.Email to "Invalid email address"), rejection.fieldErrors)
    }

    @Test
    fun `a server fault is a failure to retry, never a rejection`() = runTest {
        respond(500, apiError("internal", "Something went wrong."))
        assertEquals(InitializeOutcome.Failed(FailureKind.Server), gateway.initialize(request, key))

        respond(502, "<html>Bad gateway</html>", contentType = "text/html")
        assertEquals(InitializeOutcome.Failed(FailureKind.Server), gateway.initialize(request, key))

        respond(429, apiError("rate_limited", "Slow down."))
        // 429 carries a body but is "not now", not "no": a retry with the same key, not a refusal.
        assertEquals(InitializeOutcome.Failed(FailureKind.RateLimited), gateway.initialize(request, key))

        respond(201, """{"reference":"nope"}""")
        assertEquals(InitializeOutcome.Failed(FailureKind.Unreadable), gateway.initialize(request, key))
    }

    @Test
    fun `a dropped connection while starting a payment is a network failure`() = runTest {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        assertEquals(InitializeOutcome.Failed(FailureKind.Network), gateway.initialize(request, key))
    }
}
