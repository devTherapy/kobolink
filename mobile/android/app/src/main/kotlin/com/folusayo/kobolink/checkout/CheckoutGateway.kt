package com.folusayo.kobolink.checkout

import com.folusayo.kobolink.generated.api.apis.CheckoutApi
import com.folusayo.kobolink.generated.api.apis.LinksApi
import com.folusayo.kobolink.generated.api.models.ApiError
import com.folusayo.kobolink.generated.api.models.InitializeCheckoutRequest
import com.folusayo.kobolink.generated.api.models.PublicLinkResponse
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import retrofit2.Response

/**
 * The two network calls the checkout makes, as a seam the state machine can be
 * tested against. Neither function throws: every way a call can end is a value
 * of the return type, so no caller can forget a branch.
 */
interface CheckoutGateway {
    /** `GET /api/links/{code}/public`: unauthenticated. */
    suspend fun lookup(code: String): LookupOutcome

    /**
     * `POST /api/checkout/initialize` with an `Idempotency-Key`. [idempotencyKey] is held by the
     * caller for the life of one attempt, so a retry of the same request replays the stored
     * answer instead of creating a second checkout.
     */
    suspend fun initialize(request: InitializeRequest, idempotencyKey: String): InitializeOutcome
}

/**
 * The real gateway over the generated Retrofit interfaces. Nothing here
 * hand-writes a model: it reads `PublicLinkResponse`, `InitializeCheckoutRequest`,
 * `InitializeCheckoutResponse` and `ApiError` exactly as `openApiGenerate` produced them
 * from `apps/api/openapi.json`.
 */
class ApiCheckoutGateway(
    private val links: LinksApi,
    private val checkout: CheckoutApi,
    private val json: Json,
) : CheckoutGateway {

    override suspend fun lookup(code: String): LookupOutcome = try {
        val response = links.resolvePublicLink(code)
        val body = response.body()
        when {
            response.isSuccessful && body != null -> body.toOutcome()
            response.isSuccessful -> LookupOutcome.Failed(FailureKind.Unreadable)
            else -> {
                val error = parseError(response)
                when {
                    // Only an answer that says so is "not found": an HTML 404 from a proxy or a wrong base URL says nothing
                    // about this link.
                    error?.code == ApiError.Code.not_found -> LookupOutcome.NotFound
                    else -> LookupOutcome.Failed(failureKind(response.code(), error))
                }
            }
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: IOException) {
        LookupOutcome.Failed(FailureKind.Network)
    } catch (e: Exception) {
        // SerializationException, a date that will not parse, a body of the wrong shape.
        LookupOutcome.Failed(FailureKind.Unreadable)
    }

    override suspend fun initialize(request: InitializeRequest, idempotencyKey: String): InitializeOutcome = try {
        val response = checkout.initializeCheckout(
            idempotencyKey,
            InitializeCheckoutRequest(
                code = request.code,
                amountKobo = request.amountKobo,
                payerName = request.payerName,
                payerEmail = request.payerEmail,
            ),
        )
        val body = response.body()
        when {
            response.isSuccessful && body != null ->
                InitializeOutcome.Started(reference = body.reference, amountKobo = body.amountKobo, code = body.code)
            response.isSuccessful -> InitializeOutcome.Failed(FailureKind.Unreadable)
            else -> {
                val error = parseError(response)
                // A 4xx with a readable ApiError body is a refusal. Whether it is the server's FINAL word on the attempt
                // is not decided here: that depends on whether this was the first send, and on what the body says
                // ([sendVerdict]). A 5xx, or a 429, is "not now": a failure, retryable under the same key.
                if (error != null && response.code() < 500 && response.code() != 429) {
                    InitializeOutcome.Rejected(error.toRejection(response.code()))
                } else {
                    InitializeOutcome.Failed(failureKind(response.code(), error))
                }
            }
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: IOException) {
        InitializeOutcome.Failed(FailureKind.Network)
    } catch (e: Exception) {
        InitializeOutcome.Failed(FailureKind.Unreadable)
    }

    private fun parseError(response: Response<*>): ApiError? {
        val raw = runCatching { response.errorBody()?.string() }.getOrNull()
        if (raw.isNullOrBlank()) return null
        return runCatching { json.decodeFromString(ApiError.serializer(), raw) }.getOrNull()
    }

    private fun failureKind(httpStatus: Int, error: ApiError?): FailureKind = when {
        httpStatus == 429 || error?.code == ApiError.Code.rate_limited -> FailureKind.RateLimited
        else -> FailureKind.Server
    }
}

private fun PublicLinkResponse.toOutcome(): LookupOutcome.Found = LookupOutcome.Found(
    link = CheckoutLink(
        code = link.code,
        merchantName = link.merchantName,
        title = link.title,
        description = link.description?.takeIf { it.isNotBlank() },
        amountKobo = link.amountKobo,
        isReusable = link.isReusable,
        expiresAt = link.expiresAt,
    ),
    availability = when (state) {
        PublicLinkResponse.State.payable -> LinkAvailability.Payable
        PublicLinkResponse.State.disabled -> LinkAvailability.Disabled
        PublicLinkResponse.State.expired -> LinkAvailability.Expired
        PublicLinkResponse.State.alreadyMinusPaid -> LinkAvailability.AlreadyPaid
    },
)

private fun ApiError.toRejection(httpStatus: Int): Rejection = Rejection(
    kind = when (code) {
        ApiError.Code.link_not_payable -> RejectionKind.LinkNotPayable
        ApiError.Code.amount_mismatch -> RejectionKind.AmountMismatch
        ApiError.Code.validation_failed -> RejectionKind.ValidationFailed
        ApiError.Code.not_found -> RejectionKind.NotFound
        else -> RejectionKind.Other
    },
    message = message,
    fieldErrors = fields.orEmpty().mapNotNull { (key, messages) ->
        val field = when (key) {
            "amountKobo" -> PayerField.Amount
            "payerName" -> PayerField.Name
            "payerEmail" -> PayerField.Email
            else -> null
        }
        val first = messages.firstOrNull()
        if (field != null && first != null) field to first else null
    }.toMap(),
    moneyMoved = moneyMoved,
    httpStatus = httpStatus,
    availability = when (state) {
        ApiError.State.payable -> null // a link_not_payable that says "payable" is a contract violation; treat as unspecified
        ApiError.State.disabled -> LinkAvailability.Disabled
        ApiError.State.expired -> LinkAvailability.Expired
        ApiError.State.alreadyMinusPaid -> LinkAvailability.AlreadyPaid
        null -> null
    },
)
