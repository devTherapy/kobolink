package com.folusayo.kobolink.wallet

import com.folusayo.kobolink.generated.api.apis.WalletApi
import com.folusayo.kobolink.generated.api.models.ApiError
import com.folusayo.kobolink.generated.api.models.TransferRequest
import com.folusayo.kobolink.generated.api.models.TransferResponse
import com.folusayo.kobolink.generated.api.models.Wallet
import com.folusayo.kobolink.generated.api.models.WalletTransactionListResponse
import com.folusayo.kobolink.generated.api.models.WalletTransactionListResponseItemsInner
import java.io.IOException
import java.time.DateTimeException
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/**
 * One row of wallet activity. The OpenAPI document inlines the transaction
 * object in both `TransferResponse` and the transaction list, so the
 * generator names it after the list's item; this is the name the rest of the
 * app uses for it.
 */
typealias WalletEntry = WalletTransactionListResponseItemsInner

/** Why a wallet read failed, in words a person can act on. */
class WalletReadException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

sealed interface TransferResult {
    data class Sent(val response: TransferResponse) : TransferResult
    data class Failed(val failure: TransferFailure) : TransferResult
}

/**
 * The wallet endpoints as the screens use them. An interface so the send
 * flow and the home state can be tested with a scripted gateway, no network.
 *
 * There is deliberately no method here that could write a ledger row: the
 * only money-moving call is [transfer], which asks the server to post, and
 * the server decides (CLAUDE.md: clients never write ledger rows).
 */
interface WalletGateway {
    suspend fun wallet(): Result<Wallet>
    suspend fun transactions(cursor: String?): Result<WalletTransactionListResponse>

    /**
     * `POST /api/wallet/transfer`. [idempotencyKey] identifies ONE logical
     * attempt: replaying it with the same body returns the original result
     * instead of posting twice, which is what makes retrying after an
     * unknown outcome safe.
     */
    suspend fun transfer(idempotencyKey: String, toPhone: String, amountKobo: Long, note: String?): TransferResult
}

class WalletRepository(
    private val api: WalletApi,
    private val json: Json,
) : WalletGateway {

    override suspend fun wallet(): Result<Wallet> = read("your wallet") { api.getWallet() }

    override suspend fun transactions(cursor: String?): Result<WalletTransactionListResponse> =
        read("your recent activity") { api.listWalletTransactions(cursor = cursor, limit = PAGE_SIZE) }

    override suspend fun transfer(
        idempotencyKey: String,
        toPhone: String,
        amountKobo: Long,
        note: String?,
    ): TransferResult {
        val response = try {
            api.transferMoney(idempotencyKey, TransferRequest(toPhone = toPhone, amountKobo = amountKobo, note = note))
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            return TransferResult.Failed(classifyTransferFailure(status = null, error = null, cause = e))
        } catch (e: SerializationException) {
            // Retrofit only converts a 2xx body, so a parse failure here means
            // the server answered success and this app could not read it.
            return TransferResult.Failed(unreadableSuccess())
        } catch (e: IllegalArgumentException) {
            return TransferResult.Failed(unreadableSuccess())
        } catch (e: DateTimeException) {
            return TransferResult.Failed(unreadableSuccess())
        } catch (e: Exception) {
            // Anything else a converter or interceptor can throw (a Keystore
            // failure reading the token, say): the request may have been sent.
            return TransferResult.Failed(unexpectedFailure())
        }

        val body = response.body()
        if (response.isSuccessful) {
            return if (body != null) TransferResult.Sent(body) else TransferResult.Failed(unreadableSuccess())
        }
        return TransferResult.Failed(
            classifyTransferFailure(status = response.code(), error = parseError(response.errorBody()?.string()), cause = null),
        )
    }

    private suspend fun <T : Any> read(what: String, call: suspend () -> retrofit2.Response<T>): Result<T> = try {
        val response = call()
        val body = response.body()
        when {
            response.isSuccessful && body != null -> Result.success(body)
            response.code() == 401 -> Result.failure(WalletReadException("Your session ended. Sign in again to see $what."))
            else -> Result.failure(
                WalletReadException(
                    parseError(response.errorBody()?.string())?.message ?: "Couldn't load $what (HTTP ${response.code()}).",
                ),
            )
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: IOException) {
        Result.failure(WalletReadException("Couldn't reach Kobolink to load $what. Check your connection.", e))
    } catch (e: SerializationException) {
        Result.failure(WalletReadException("Kobolink sent something this app couldn't read while loading $what.", e))
    } catch (e: IllegalArgumentException) {
        Result.failure(WalletReadException("Kobolink sent something this app couldn't read while loading $what.", e))
    } catch (e: DateTimeException) {
        Result.failure(WalletReadException("Kobolink sent something this app couldn't read while loading $what.", e))
    }

    private fun parseError(raw: String?): ApiError? {
        if (raw.isNullOrBlank()) return null
        return runCatching { json.decodeFromString(ApiError.serializer(), raw) }.getOrNull()
    }

    private companion object {
        const val PAGE_SIZE = 20L
    }
}
