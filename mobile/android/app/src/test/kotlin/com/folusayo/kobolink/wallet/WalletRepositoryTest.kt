package com.folusayo.kobolink.wallet

import com.folusayo.kobolink.generated.api.infrastructure.Serializer
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.SerializationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import retrofit2.Response

/** The HTTP-to-result mapping, with a scripted Retrofit interface in place of the network. */
class WalletRepositoryTest {

    private val json = Serializer.kotlinxSerializationJson

    private fun repo(api: FakeWalletApi) = WalletRepository(api, json)

    private fun failed(result: TransferResult) = (result as TransferResult.Failed).failure

    @Test
    fun `a transfer sends the key, the E164 number, the kobo amount and the note - nothing else`() = runTest {
        val api = FakeWalletApi(transfer = { _, _ -> Response.success(201, transferResponse("p_1", 250_000, 750_000)) })

        val result = repo(api).transfer("key-0123456789abcdef", "+2348031234567", 250_000L, "rent")

        assertTrue(result is TransferResult.Sent)
        val (key, body) = api.lastTransfer!!
        assertEquals("key-0123456789abcdef", key)
        assertEquals("+2348031234567", body.toPhone)
        assertEquals(250_000L, body.amountKobo)
        assertEquals("rent", body.note)
        assertEquals(750_000L, (result as TransferResult.Sent).response.wallet.balanceKobo)
    }

    @Test
    fun `an insufficient funds reply is a no-money failure`() = runTest {
        val api = FakeWalletApi(
            transfer = { _, _ ->
                Response.error(422, apiErrorBody("insufficient_funds", "Insufficient wallet balance.", ""","moneyMoved":false"""))
            },
        )

        val failure = failed(repo(api).transfer("k".repeat(16), "+2348031234567", 250_000L, null))

        assertEquals(TransferFailureKind.InsufficientFunds, failure.kind)
        assertEquals(MoneyMoved.No, failure.moneyMoved)
    }

    @Test
    fun `a field error from the server is carried through`() = runTest {
        val api = FakeWalletApi(
            transfer = { _, _ ->
                Response.error(
                    400,
                    apiErrorBody("validation_failed", "Invalid.", ""","fields":{"toPhone":["not a Nigerian mobile number"]},"moneyMoved":false"""),
                )
            },
        )

        val failure = failed(repo(api).transfer("k".repeat(16), "+2348031234567", 250_000L, null))

        assertEquals(TransferFailureKind.InvalidDetails, failure.kind)
        assertEquals(listOf("not a Nigerian mobile number"), failure.fields["toPhone"])
    }

    @Test
    fun `a 502 from a proxy with an HTML body is an unknown outcome`() = runTest {
        val api = FakeWalletApi(
            transfer = { _, _ ->
                Response.error(502, "<html>Bad gateway</html>".toResponseBody("text/html".toMediaType()))
            },
        )

        val failure = failed(repo(api).transfer("k".repeat(16), "+2348031234567", 250_000L, null))

        assertEquals(TransferFailureKind.ServerError, failure.kind)
        assertEquals(MoneyMoved.Unknown, failure.moneyMoved)
    }

    @Test
    fun `no network - the request never left, so no money moved`() = runTest {
        val api = FakeWalletApi(transfer = { _, _ -> throw UnknownHostException("pay.folusayo.com") })
        val failure = failed(repo(api).transfer("k".repeat(16), "+2348031234567", 250_000L, null))
        assertEquals(TransferFailureKind.Offline, failure.kind)
        assertEquals(MoneyMoved.No, failure.moneyMoved)
    }

    @Test
    fun `a timeout after sending is an unknown outcome`() = runTest {
        val api = FakeWalletApi(transfer = { _, _ -> throw SocketTimeoutException("timeout") })
        val failure = failed(repo(api).transfer("k".repeat(16), "+2348031234567", 250_000L, null))
        assertEquals(MoneyMoved.Unknown, failure.moneyMoved)
        assertTrue(failure.retryWithSameRequest)
    }

    @Test
    fun `a success whose body cannot be read is an unknown outcome, not a crash`() = runTest {
        val api = FakeWalletApi(transfer = { _, _ -> throw SerializationException("bad body") })
        val failure = failed(repo(api).transfer("k".repeat(16), "+2348031234567", 250_000L, null))
        assertEquals(TransferFailureKind.Unreadable, failure.kind)
        assertEquals(MoneyMoved.Unknown, failure.moneyMoved)
    }

    @Test
    fun `a 201 with no body is treated the same way`() = runTest {
        val api = FakeWalletApi(transfer = { _, _ -> Response.success(201, null as com.folusayo.kobolink.generated.api.models.TransferResponse?) })
        val failure = failed(repo(api).transfer("k".repeat(16), "+2348031234567", 250_000L, null))
        assertEquals(TransferFailureKind.Unreadable, failure.kind)
    }

    // ---- reads ----

    @Test
    fun `reads return the wallet and the page`() = runTest {
        val api = FakeWalletApi(
            getWallet = { Response.success(wallet(3_000_000_000L)) },
            list = { cursor, limit ->
                assertEquals("cur", cursor)
                assertEquals(20L, limit)
                Response.success(page(entry("p_1", 100), next = null))
            },
        )
        assertEquals(3_000_000_000L, repo(api).wallet().getOrThrow().balanceKobo)
        val page = repo(api).transactions("cur").getOrThrow()
        assertEquals(listOf("p_1"), page.items.map { it.postingId })
        assertNull(page.nextCursor)
    }

    @Test
    fun `a failed read says what could not be loaded`() = runTest {
        val offline = FakeWalletApi(getWallet = { throw UnknownHostException() })
        val message = repo(offline).wallet().exceptionOrNull()?.message.orEmpty()
        assertTrue(message, message.contains("your wallet"))
        assertTrue(message, message.contains("connection"))

        val expired = FakeWalletApi(list = { _, _ -> Response.error(401, apiErrorBody("unauthenticated", "x")) })
        val expiredMessage = repo(expired).transactions(null).exceptionOrNull()?.message.orEmpty()
        assertTrue(expiredMessage, expiredMessage.contains("Sign in"))

        val server = FakeWalletApi(getWallet = { Response.error(500, apiErrorBody("internal", "Something broke.")) })
        assertEquals("Something broke.", repo(server).wallet().exceptionOrNull()?.message)
    }
}
