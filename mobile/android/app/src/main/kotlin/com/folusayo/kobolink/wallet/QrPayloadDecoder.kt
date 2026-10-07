package com.folusayo.kobolink.wallet

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/** What a scanned Kobolink QR code resolves to: exactly the fields the transfer form needs. */
data class ScannedPayee(
    val toPhone: String,
    val displayName: String,
    /** A requested amount, or null when the payer chooses. */
    val amountKobo: Long?,
)

enum class QrRejection(val message: String) {
    /** Not text we can read as a Kobolink payload at all (a website QR, a Wi-Fi code, noise). */
    NotKobolink("This isn't a Kobolink payment code."),

    /** A `v` other than 1: a newer app made it, and guessing at its fields could send money to the wrong place. */
    UnsupportedVersion("This code was made by a newer version of Kobolink. Update the app to pay with it."),

    /** Right shape, bad contents: a phone number or amount outside what a transfer accepts. */
    Invalid("This payment code is damaged or has details Kobolink can't use."),
}

sealed interface QrDecodeResult {
    data class Success(val payee: ScannedPayee) : QrDecodeResult
    data class Rejected(val reason: QrRejection) : QrDecodeResult
}

/**
 * Decodes the text of a scanned QR code into a [ScannedPayee].
 *
 * The format is `QrPayload` from `packages/contracts/src/wallet.ts`, built by
 * `buildQrPayload` in `apps/api/src/wallet/qr-payload.ts`:
 * `{"v":1,"toPhone":"+234...","displayName":"...","amountKobo":null|<int>}`.
 * contracts defines the object and nothing about how it is serialised into
 * the QR; JSON text is the only reading its schema supports, and this is the
 * paying side's whole contract with it. A decoded payload needs no new
 * endpoint: `toPhone` and `amountKobo` are exactly what
 * `POST /api/wallet/transfer` takes.
 *
 * Strict by design, because a wrong guess here sends money: an unknown
 * version, a phone that is not already E.164, a name that is blank, or an
 * amount outside the transfer bounds are all rejected rather than repaired.
 * The generated `QrPayload` Kotlin class is not used: the generator renders
 * its `v` as a one-value BigDecimal enum and its supertype as a HashMap,
 * neither of which is a usable decoder, and a few lines of explicit checks
 * are clearer than that.
 */
fun decodeQrPayload(raw: String): QrDecodeResult {
    if (raw.length > MAX_QR_TEXT_LENGTH) return QrDecodeResult.Rejected(QrRejection.NotKobolink)

    val parsed: JsonElement? = try {
        Json.parseToJsonElement(raw)
    } catch (_: Exception) {
        null
    }
    val root = parsed as? JsonObject ?: return QrDecodeResult.Rejected(QrRejection.NotKobolink)

    // Not our payload at all if it has no version marker; a version we don't
    // know is a different, more useful message.
    val version = root["v"] ?: return QrDecodeResult.Rejected(QrRejection.NotKobolink)
    if (version !is JsonPrimitive || version.isString || version.longOrNull != SUPPORTED_VERSION) {
        return QrDecodeResult.Rejected(QrRejection.UnsupportedVersion)
    }

    val phone = (root["toPhone"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    if (phone == null || !NigerianPhone.isValid(phone)) return QrDecodeResult.Rejected(QrRejection.Invalid)

    val name = (root["displayName"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()
    if (name.isNullOrEmpty() || name.length > MAX_DISPLAY_NAME_LENGTH) return QrDecodeResult.Rejected(QrRejection.Invalid)

    val amountElement: JsonElement? = root["amountKobo"]
    val amount: Long? = when {
        amountElement == null -> return QrDecodeResult.Rejected(QrRejection.Invalid)
        amountElement is JsonNull -> null
        amountElement is JsonPrimitive && !amountElement.isString -> amountElement.longOrNull
            ?.takeIf { it in TransferLimits.MIN_AMOUNT_KOBO..TransferLimits.MAX_AMOUNT_KOBO }
            ?: return QrDecodeResult.Rejected(QrRejection.Invalid)
        else -> return QrDecodeResult.Rejected(QrRejection.Invalid)
    }

    return QrDecodeResult.Success(ScannedPayee(toPhone = phone, displayName = name, amountKobo = amount))
}

private const val SUPPORTED_VERSION = 1L
private const val MAX_DISPLAY_NAME_LENGTH = 80

/** A payload is ~150 bytes; anything far larger is not one, and is not worth parsing. */
private const val MAX_QR_TEXT_LENGTH = 2_000
