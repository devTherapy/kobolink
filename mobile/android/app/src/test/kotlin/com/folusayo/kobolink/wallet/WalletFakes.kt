package com.folusayo.kobolink.wallet

import com.folusayo.kobolink.generated.api.apis.WalletApi
import com.folusayo.kobolink.generated.api.models.TopUpRequest
import com.folusayo.kobolink.generated.api.models.TransferRequest
import com.folusayo.kobolink.generated.api.models.TransferResponse
import com.folusayo.kobolink.generated.api.models.TransferResponseWallet
import com.folusayo.kobolink.generated.api.models.Wallet
import com.folusayo.kobolink.generated.api.models.WalletTransactionListResponse
import com.folusayo.kobolink.generated.api.models.WalletTransactionListResponseItemsInner
import java.time.OffsetDateTime
import kotlinx.coroutines.CompletableDeferred
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import retrofit2.Response

internal val at: OffsetDateTime = OffsetDateTime.parse("2026-10-07T10:00:00Z")

internal fun wallet(balanceKobo: Long, asOf: OffsetDateTime = at) = Wallet("acc_1", Wallet.Currency.NGN, balanceKobo, asOf)

internal fun entry(
    id: String,
    amountKobo: Long,
    counterparty: String? = "Ada Obi",
    note: String? = null,
    kind: WalletTransactionListResponseItemsInner.Kind = WalletTransactionListResponseItemsInner.Kind.transfer,
) = WalletTransactionListResponseItemsInner(
    postingId = id,
    kind = kind,
    amountKobo = amountKobo,
    counterparty = counterparty,
    note = note,
    createdAt = at,
)

internal fun transferResponse(
    id: String,
    amountKobo: Long,
    newBalanceKobo: Long,
    counterparty: String? = "Ada Obi",
    asOf: OffsetDateTime = at,
) = TransferResponse(
    transaction = entry(id, -amountKobo, counterparty),
    wallet = TransferResponseWallet("acc_1", TransferResponseWallet.Currency.NGN, newBalanceKobo, asOf),
)

internal fun page(vararg items: WalletEntry, next: String? = null) =
    WalletTransactionListResponse(items = items.toList(), nextCursor = next)

internal fun apiErrorBody(code: String, message: String, extra: String = "") =
    """{"code":"$code","message":"$message"$extra}""".toResponseBody("application/json".toMediaType())

/** A scripted [WalletGateway]: record what it was asked, answer from queues, optionally hold a transfer open. */
internal class FakeGateway : WalletGateway {
    val transferCalls = mutableListOf<TransferCall>()
    var walletResults = ArrayDeque<Result<Wallet>>()
    var pageResults = ArrayDeque<Result<WalletTransactionListResponse>>()
    var transferResults = ArrayDeque<TransferResult>()
    var transferThrows: Throwable? = null

    /** When set, the next [transfer] suspends until this completes. */
    var gate: CompletableDeferred<Unit>? = null

    /** When set, [wallet] suspends until this completes, so a read can be "in flight" while something else happens. */
    var readGate: CompletableDeferred<Unit>? = null

    /** When set, a page request WITH a cursor (load more) suspends until this completes, after taking its stub. */
    var pageGate: CompletableDeferred<Unit>? = null

    var walletCalls = 0
    val pageCursors = mutableListOf<String?>()

    data class TransferCall(val key: String, val toPhone: String, val amountKobo: Long, val note: String?)

    override suspend fun wallet(): Result<Wallet> {
        walletCalls += 1
        readGate?.await()
        return walletResults.removeFirstOrNull() ?: Result.failure(WalletReadException("no wallet stub"))
    }

    override suspend fun transactions(cursor: String?): Result<WalletTransactionListResponse> {
        pageCursors += cursor
        val result = pageResults.removeFirstOrNull() ?: Result.failure(WalletReadException("no page stub"))
        if (cursor != null) pageGate?.await()
        return result
    }

    override suspend fun transfer(idempotencyKey: String, toPhone: String, amountKobo: Long, note: String?): TransferResult {
        transferCalls += TransferCall(idempotencyKey, toPhone, amountKobo, note)
        gate?.await()
        transferThrows?.let { throw it }
        return transferResults.removeFirstOrNull() ?: error("no transfer stub")
    }
}

/** A scripted Retrofit [WalletApi], for the repository's HTTP-to-result mapping. */
internal class FakeWalletApi(
    var transfer: suspend (String, TransferRequest) -> Response<TransferResponse> = { _, _ -> error("no transfer stub") },
    var getWallet: suspend () -> Response<Wallet> = { error("no wallet stub") },
    var list: suspend (String?, Long?) -> Response<WalletTransactionListResponse> = { _, _ -> error("no list stub") },
) : WalletApi {
    var lastTransfer: Pair<String, TransferRequest>? = null

    override suspend fun getWallet() = getWallet.invoke()
    override suspend fun listWalletTransactions(cursor: String?, limit: Long?) = list(cursor, limit)
    override suspend fun topUpWallet(idempotencyKey: String, topUpRequest: TopUpRequest): Response<TransferResponse> =
        error("the app never tops up")

    override suspend fun transferMoney(idempotencyKey: String, transferRequest: TransferRequest): Response<TransferResponse> {
        lastTransfer = idempotencyKey to transferRequest
        return transfer(idempotencyKey, transferRequest)
    }
}
