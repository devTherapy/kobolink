package com.folusayo.kobolink.wallet

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The paying side of B8's QR: a scanned payload must decode to exactly the
 * fields `POST /api/wallet/transfer` takes, and anything not exactly a
 * version-1 payload must be refused, because a wrong guess sends money.
 */
class QrPayloadDecoderTest {

    private fun payload(
        v: String = "1",
        phone: String = "\"+2348031234567\"",
        name: String = "\"Ada Obi\"",
        amount: String = "null",
    ) = """{"v":$v,"toPhone":$phone,"displayName":$name,"amountKobo":$amount}"""

    private fun rejected(raw: String, reason: QrRejection) =
        assertEquals(QrDecodeResult.Rejected(reason), decodeQrPayload(raw))

    @Test
    fun `decodes a payload with no amount`() {
        assertEquals(
            QrDecodeResult.Success(ScannedPayee("+2348031234567", "Ada Obi", null)),
            decodeQrPayload(payload()),
        )
    }

    @Test
    fun `decodes a payload that requests an amount`() {
        assertEquals(
            QrDecodeResult.Success(ScannedPayee("+2348031234567", "Ada Obi", 250_000L)),
            decodeQrPayload(payload(amount = "250000")),
        )
    }

    @Test
    fun `ignores fields it does not know`() {
        val raw = """{"v":1,"toPhone":"+2348031234567","displayName":"Ada","amountKobo":null,"extra":true}"""
        assertEquals(QrDecodeResult.Success(ScannedPayee("+2348031234567", "Ada", null)), decodeQrPayload(raw))
    }

    @Test
    fun `trims the display name`() {
        assertEquals(
            QrDecodeResult.Success(ScannedPayee("+2348031234567", "Ada Obi", null)),
            decodeQrPayload(payload(name = "\"  Ada Obi \"")),
        )
    }

    @Test
    fun `text that is not a payload at all is not Kobolink`() {
        rejected("https://pay.folusayo.com/l/abc123", QrRejection.NotKobolink)
        rejected("WIFI:T:WPA;S:cafe;P:secret;;", QrRejection.NotKobolink)
        rejected("12345", QrRejection.NotKobolink)
        rejected("", QrRejection.NotKobolink)
        rejected("[1,2,3]", QrRejection.NotKobolink)
        rejected("""{"hello":"world"}""", QrRejection.NotKobolink)
        rejected("{not json", QrRejection.NotKobolink)
        rejected("x".repeat(5_000), QrRejection.NotKobolink)
    }

    @Test
    fun `an unknown version is refused, not guessed at`() {
        rejected(payload(v = "2"), QrRejection.UnsupportedVersion)
        rejected(payload(v = "0"), QrRejection.UnsupportedVersion)
        rejected(payload(v = "\"1\""), QrRejection.UnsupportedVersion)
        rejected(payload(v = "1.5"), QrRejection.UnsupportedVersion)
        rejected(payload(v = "null"), QrRejection.UnsupportedVersion)
    }

    @Test
    fun `a bad phone number is refused`() {
        rejected(payload(phone = "\"08031234567\""), QrRejection.Invalid)      // not E.164: the contract's wire form is
        rejected(payload(phone = "\"+14155550100\""), QrRejection.Invalid)
        rejected(payload(phone = "8031234567"), QrRejection.Invalid)           // a number, not a string
        rejected("""{"v":1,"displayName":"Ada","amountKobo":null}""", QrRejection.Invalid)
    }

    @Test
    fun `a missing or blank name is refused`() {
        rejected(payload(name = "\"   \""), QrRejection.Invalid)
        rejected(payload(name = "null"), QrRejection.Invalid)
        rejected(payload(name = "\"${"n".repeat(81)}\""), QrRejection.Invalid)
    }

    @Test
    fun `an amount outside the transfer bounds is refused, not clamped`() {
        rejected(payload(amount = "9999"), QrRejection.Invalid)
        rejected(payload(amount = "1000000001"), QrRejection.Invalid)
        rejected(payload(amount = "0"), QrRejection.Invalid)
        rejected(payload(amount = "-50000"), QrRejection.Invalid)
        rejected(payload(amount = "1500.5"), QrRejection.Invalid)
        rejected(payload(amount = "\"1500\""), QrRejection.Invalid)
    }

    @Test
    fun `the amount key must be present as the contract requires`() {
        rejected("""{"v":1,"toPhone":"+2348031234567","displayName":"Ada"}""", QrRejection.Invalid)
    }

    @Test
    fun `the bounds themselves decode`() {
        assertEquals(
            QrDecodeResult.Success(ScannedPayee("+2348031234567", "Ada Obi", 10_000L)),
            decodeQrPayload(payload(amount = "10000")),
        )
        assertEquals(
            QrDecodeResult.Success(ScannedPayee("+2348031234567", "Ada Obi", 1_000_000_000L)),
            decodeQrPayload(payload(amount = "1000000000")),
        )
    }
}
