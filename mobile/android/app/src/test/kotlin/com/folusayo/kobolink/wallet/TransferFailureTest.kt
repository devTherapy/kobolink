package com.folusayo.kobolink.wallet

import com.folusayo.kobolink.generated.api.models.ApiError
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Every way `POST /api/wallet/transfer` can fail, and what each says about the sender's money. */
class TransferFailureTest {

    private fun error(
        code: ApiError.Code,
        message: String = "msg",
        moneyMoved: Boolean? = false,
        fields: Map<String, List<String>>? = null,
    ) = ApiError(code = code, message = message, fields = fields, moneyMoved = moneyMoved)

    private fun classify(status: Int, error: ApiError?) = classifyTransferFailure(status, error, null)

    @Test
    fun `insufficient funds - money did not move`() {
        val f = classify(422, error(ApiError.Code.insufficient_funds))
        assertEquals(TransferFailureKind.InsufficientFunds, f.kind)
        assertEquals(MoneyMoved.No, f.moneyMoved)
        assertTrue(f.canEditAndResend)
        assertFalse(f.retryWithSameRequest)
    }

    @Test
    fun `unknown recipient - money did not move`() {
        val f = classify(404, error(ApiError.Code.not_found))
        assertEquals(TransferFailureKind.RecipientNotFound, f.kind)
        assertEquals(MoneyMoved.No, f.moneyMoved)
    }

    @Test
    fun `self transfer is told apart from other validation errors`() {
        val self = classify(
            400,
            error(ApiError.Code.validation_failed, "You cannot transfer money to yourself.", fields = mapOf("toPhone" to listOf("cannot transfer to yourself"))),
        )
        assertEquals(TransferFailureKind.SelfTransfer, self.kind)
        assertEquals(MoneyMoved.No, self.moneyMoved)

        val other = classify(
            400,
            error(ApiError.Code.validation_failed, "Invalid request.", moneyMoved = null, fields = mapOf("amountKobo" to listOf("too small"))),
        )
        assertEquals(TransferFailureKind.InvalidDetails, other.kind)
        assertEquals(MoneyMoved.No, other.moneyMoved) // a 4xx rejection happens before posting even without the flag
    }

    @Test
    fun `an expired session is a no-money failure`() {
        val f = classify(401, error(ApiError.Code.unauthenticated, moneyMoved = null))
        assertEquals(TransferFailureKind.SessionExpired, f.kind)
        assertEquals(MoneyMoved.No, f.moneyMoved)
        assertEquals(TransferFailureKind.SessionExpired, classify(401, null).kind)
    }

    @Test
    fun `rate limited is a no-money failure that is worth retrying`() {
        val f = classify(429, error(ApiError.Code.rate_limited, moneyMoved = null))
        assertEquals(TransferFailureKind.RateLimited, f.kind)
        assertEquals(MoneyMoved.No, f.moneyMoved)
        assertTrue(f.worthTryingAgain)
    }

    @Test
    fun `an idempotency mismatch is told apart`() {
        val f = classify(422, error(ApiError.Code.idempotency_mismatch))
        assertEquals(TransferFailureKind.KeyReusedWithDifferentDetails, f.kind)
        assertEquals(MoneyMoved.No, f.moneyMoved)
    }

    @Test
    fun `a 5xx without a no-money flag is unknown and must be replayed, not edited`() {
        val f = classify(500, error(ApiError.Code.`internal`, moneyMoved = null))
        assertEquals(TransferFailureKind.ServerError, f.kind)
        assertEquals(MoneyMoved.Unknown, f.moneyMoved)
        assertTrue(f.retryWithSameRequest)
        assertFalse("editing and resending an unknown outcome is how a person pays twice", f.canEditAndResend)
    }

    @Test
    fun `a 5xx with no JSON body is unknown too`() {
        val f = classify(502, null)
        assertEquals(TransferFailureKind.ServerError, f.kind)
        assertEquals(MoneyMoved.Unknown, f.moneyMoved)
    }

    @Test
    fun `a 5xx that says no money moved is believed`() {
        val f = classify(503, error(ApiError.Code.`internal`, moneyMoved = false))
        assertEquals(MoneyMoved.No, f.moneyMoved)
    }

    @Test
    fun `a 409 conflict is not assumed to be a no-money failure`() {
        val f = classify(409, error(ApiError.Code.conflict, moneyMoved = null))
        assertEquals(MoneyMoved.Unknown, f.moneyMoved)
    }

    @Test
    fun `no connection at all means the request never left the phone`() {
        for (cause in listOf(UnknownHostException("no dns"), ConnectException("refused"))) {
            val f = classifyTransferFailure(null, null, cause)
            assertEquals(TransferFailureKind.Offline, f.kind)
            assertEquals(MoneyMoved.No, f.moneyMoved)
        }
    }

    @Test
    fun `a timeout or a dropped connection mid-request is unknown`() {
        for (cause in listOf<IOException>(SocketTimeoutException("read timed out"), IOException("connection reset"))) {
            val f = classifyTransferFailure(null, null, cause)
            assertEquals(TransferFailureKind.Offline, f.kind)
            assertEquals(MoneyMoved.Unknown, f.moneyMoved)
            assertTrue(f.retryWithSameRequest)
            assertFalse(f.canEditAndResend)
        }
    }

    @Test
    fun `an unreadable success is unknown and replayable`() {
        val f = unreadableSuccess()
        assertEquals(MoneyMoved.Unknown, f.moneyMoved)
        assertTrue(f.retryWithSameRequest)
    }

    @Test
    fun `every failure kind has words that name the amount, the recipient and whether money moved`() {
        val attempt = TransferAttempt("k", "+2348031234567", 250_000L, null, "Ada Obi")
        val cases = listOf(
            classify(422, error(ApiError.Code.insufficient_funds)),
            classify(404, error(ApiError.Code.not_found)),
            classify(400, error(ApiError.Code.validation_failed, fields = mapOf("toPhone" to listOf("cannot transfer to yourself")))),
            classify(400, error(ApiError.Code.validation_failed, "Bad amount.", fields = mapOf("amountKobo" to listOf("too small")))),
            classify(422, error(ApiError.Code.idempotency_mismatch)),
            classify(401, null),
            classify(429, null),
            classify(500, null),
            classifyTransferFailure(null, null, UnknownHostException()),
            classifyTransferFailure(null, null, SocketTimeoutException()),
            unreadableSuccess(),
            TransferFailure(TransferFailureKind.Interrupted, MoneyMoved.Unknown),
        )
        assertEquals(TransferFailureKind.entries.toSet(), cases.map { it.kind }.toSet())

        for (failure in cases) {
            val text = describeFailure(failure, attempt, balanceKobo = 100_000L)
            assertTrue("${failure.kind} needs a title", text.title.isNotBlank())
            assertTrue("${failure.kind} needs detail", text.detail.isNotBlank())
            when (failure.moneyMoved) {
                MoneyMoved.No -> assertTrue(text.moneyLine, text.moneyLine.startsWith("No money was taken"))
                MoneyMoved.Unknown -> assertTrue(text.moneyLine, text.moneyLine.contains("can't tell whether"))
                MoneyMoved.Yes -> assertTrue(text.moneyLine, text.moneyLine.contains("was sent"))
            }
        }
    }

    @Test
    fun `insufficient funds names the amount, the number and the balance shown`() {
        val attempt = TransferAttempt("k", "+2348031234567", 250_000L, null, "Ada Obi")
        val text = describeFailure(classify(422, error(ApiError.Code.insufficient_funds)), attempt, balanceKobo = 100_000L)
        assertEquals("Not enough money in your wallet", text.title)
        assertTrue(text.detail, text.detail.contains("₦2,500"))
        assertTrue(text.detail, text.detail.contains("+234 803 123 4567"))
        assertTrue("a QR code's name is not the identity of the recipient: ${text.detail}", !text.detail.contains("Ada Obi"))
        assertTrue(text.detail, text.detail.contains("₦1,000"))
    }

    @Test
    fun `an unknown outcome tells the person where to look before paying again`() {
        val attempt = TransferAttempt("k", "+2348031234567", 250_000L, null, null)
        val text = describeFailure(classifyTransferFailure(null, null, SocketTimeoutException()), attempt, null)
        assertTrue(text.moneyLine, text.moneyLine.contains("Recent activity"))
        assertTrue(text.detail, text.detail.contains("+234 803 123 4567")) // no QR name: the formatted number stands in
        assertTrue(text.detail, text.detail.contains("safe"))
    }
}
