package com.folusayo.kobolink.wallet

import com.folusayo.kobolink.generated.api.models.ApiError

/**
 * Whether money left the sender's wallet. The question every failed transfer
 * has to answer, because "it failed" and "it failed and you were charged" are
 * not the same news (docs/DESIGN-SPEC.md, PLAN.md M4's bar applied here).
 */
enum class MoneyMoved {
    /**
     * The server SAID it refused the request before posting: an error reply
     * with a body we could read (or this app never sent it, see
     * [TransferFailureKind.SecureStorageFailed]). A transport failure is never
     * this: "could not connect" does not prove an earlier copy did not arrive.
     */
    No,

    /** The server accepted and posted the transfer. */
    Yes,

    /** The request may or may not have been posted: a timeout, a dropped connection, a 5xx. */
    Unknown,
}

enum class TransferFailureKind {
    InsufficientFunds,
    RecipientNotFound,
    SelfTransfer,
    InvalidDetails,
    KeyReusedWithDifferentDetails,
    SessionExpired,
    RateLimited,
    ServerError,
    Offline,
    Unreadable,
    Interrupted,

    /** The device would not durably record the payment, so it was not sent. Nothing left the phone. */
    SecureStorageFailed,
}

/**
 * Why a transfer did not come back as a success, and what that means for the
 * sender's money.
 *
 * [moneyMoved] is the load-bearing field. [MoneyMoved.Unknown] is the only
 * state in which the same request must be retried with the same
 * `Idempotency-Key` (the server then returns the original result instead of
 * posting twice) and in which editing the details and sending again could
 * pay twice; see [retryWithSameRequest] and [canEditAndResend].
 */
data class TransferFailure(
    val kind: TransferFailureKind,
    val moneyMoved: MoneyMoved,
    /** The server's own `message`, when it sent one; shown only where it adds something. */
    val serverMessage: String? = null,
    /** The server's per-field complaints (`ApiError.fields`), by request field name. */
    val fields: Map<String, List<String>> = emptyMap(),
) {
    /**
     * Replay the identical request under the identical key. Only meaningful
     * when the outcome is unknown; when nothing was sent or the server said no,
     * the person edits or simply tries again as a fresh attempt.
     */
    val retryWithSameRequest: Boolean get() = moneyMoved != MoneyMoved.No

    /**
     * Safe to change the recipient or amount and send as a new payment. Not
     * while the previous one might have posted: that is how a person pays twice.
     */
    val canEditAndResend: Boolean get() = moneyMoved == MoneyMoved.No

    /** Nothing wrong with the details; trying the very same thing again can succeed (offline, rate limit, a 5xx that posted nothing). */
    val worthTryingAgain: Boolean
        get() = kind == TransferFailureKind.Offline ||
            kind == TransferFailureKind.RateLimited ||
            kind == TransferFailureKind.ServerError ||
            kind == TransferFailureKind.Unreadable ||
            kind == TransferFailureKind.SecureStorageFailed
}

/**
 * Maps what came back (or didn't) from `POST /api/wallet/transfer` to a
 * [TransferFailure].
 *
 * [status] is the HTTP status, or null when there was no HTTP response.
 * [error] is the parsed `ApiError` body, when there was one. [cause] is the
 * transport exception, when there was no response (unused: every transport
 * failure classifies the same way).
 *
 * Money-moved rules:
 * - **No** only on a server answer: an error reply whose body was parsed
 *   (4xx other than 408/409), or any parsed reply that says
 *   `moneyMoved: false`. Never an idempotency mismatch: that says the key was
 *   used before, with other details, so an earlier payment may exist.
 * - **Unknown** for everything else, including EVERY transport exception.
 *   Even "unknown host" and "connection refused" are not proof the request
 *   never left: a client that retries on a fresh connection can have delivered
 *   the first copy before the exception was thrown. (The wallet client turns
 *   that retry off, but the classification does not lean on it.)
 */
fun classifyTransferFailure(status: Int?, error: ApiError?, cause: Throwable?): TransferFailure {
    if (status == null) return TransferFailure(kind = TransferFailureKind.Offline, moneyMoved = MoneyMoved.Unknown)

    val serverSaysNoMoney = error?.moneyMoved == false
    val rejectedBeforePosting = error != null && status in 400..499 && status != 408 && status != 409
    val keyAlreadyUsed = error?.code == ApiError.Code.idempotency_mismatch
    val moneyMoved = if (!keyAlreadyUsed && (serverSaysNoMoney || rejectedBeforePosting)) MoneyMoved.No else MoneyMoved.Unknown

    fun failure(kind: TransferFailureKind) = TransferFailure(
        kind = kind,
        moneyMoved = moneyMoved,
        serverMessage = error?.message,
        fields = error?.fields.orEmpty(),
    )

    return when {
        error?.code == ApiError.Code.insufficient_funds -> failure(TransferFailureKind.InsufficientFunds)
        error?.code == ApiError.Code.not_found || (error == null && status == 404) ->
            failure(TransferFailureKind.RecipientNotFound)
        error?.code == ApiError.Code.idempotency_mismatch -> failure(TransferFailureKind.KeyReusedWithDifferentDetails)
        error?.code == ApiError.Code.unauthenticated || status == 401 -> failure(TransferFailureKind.SessionExpired)
        error?.code == ApiError.Code.rate_limited || status == 429 -> failure(TransferFailureKind.RateLimited)
        error?.code == ApiError.Code.validation_failed ->
            failure(if (isSelfTransfer(error)) TransferFailureKind.SelfTransfer else TransferFailureKind.InvalidDetails)
        status in 400..499 && status != 408 && status != 409 -> failure(TransferFailureKind.InvalidDetails)
        else -> failure(TransferFailureKind.ServerError)
    }
}

/**
 * A reply this app could not read after a successful send. The status line
 * was not available to look at, so this cannot claim the transfer posted; it
 * most likely did, and replaying the same request returns the original result.
 */
fun unreadableSuccess(): TransferFailure =
    TransferFailure(kind = TransferFailureKind.Unreadable, moneyMoved = MoneyMoved.Unknown)

/** Something this app did not anticipate went wrong around the call. A request may have gone out, so: unknown, and replayable. */
fun unexpectedFailure(): TransferFailure =
    TransferFailure(kind = TransferFailureKind.ServerError, moneyMoved = MoneyMoved.Unknown)

private fun isSelfTransfer(error: ApiError): Boolean =
    error.fields?.get("toPhone").orEmpty().any { it.contains("yourself", ignoreCase = true) } ||
        error.message.contains("yourself", ignoreCase = true)
