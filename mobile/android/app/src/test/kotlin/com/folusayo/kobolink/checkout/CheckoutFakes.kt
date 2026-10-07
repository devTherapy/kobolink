package com.folusayo.kobolink.checkout

import java.time.OffsetDateTime
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred

/** One call the checkout made, held open until the test decides how it ends. */
class PendingCall<Q, R>(val request: Q) {
    val answer = CompletableDeferred<R>()

    /** True once the coroutine awaiting this call was cancelled: the controller really abandoned the request. */
    var cancelled = false
        internal set

    fun complete(result: R) {
        answer.complete(result)
    }
}

/**
 * A gateway whose calls stay in flight until a test completes them, so a test can finish them in any order. That is
 * the whole point: a latest-wins bug is only visible when the old answer arrives after the new one.
 *
 * By default a call is cancellable like a real suspending HTTP call, and records that it was cancelled. With
 * [ignoreCancellation] a call behaves like one that does not notice cancellation (a response already read off the
 * socket, a callback that resumes regardless): it still returns its answer after the controller has moved on. That
 * is the case the controller's generation check exists for, and the only way to see it work separately from
 * `Job.cancel()`.
 */
class FakeCheckoutGateway(private val ignoreCancellation: Boolean = false) : CheckoutGateway {
    val lookups = mutableListOf<PendingCall<String, LookupOutcome>>()
    val initializes = mutableListOf<PendingCall<Pair<InitializeRequest, String>, InitializeOutcome>>()

    override suspend fun lookup(code: String): LookupOutcome {
        val call = PendingCall<String, LookupOutcome>(code)
        lookups += call
        return await(call)
    }

    override suspend fun initialize(request: InitializeRequest, idempotencyKey: String): InitializeOutcome {
        val call = PendingCall<Pair<InitializeRequest, String>, InitializeOutcome>(request to idempotencyKey)
        initializes += call
        return await(call)
    }

    private suspend fun <Q, R> await(call: PendingCall<Q, R>): R {
        if (ignoreCancellation) {
            // A raw suspendCoroutine is not a cancellation point: the coroutine is resumed with the answer even
            // though its Job was cancelled, exactly like a call that does not notice.
            return suspendCoroutine { continuation ->
                call.answer.invokeOnCompletion { continuation.resume(call.answer.getCompleted()) }
            }
        }
        return try {
            call.answer.await()
        } catch (e: CancellationException) {
            call.cancelled = true
            throw e
        }
    }
}

fun link(
    code: String = "7hK2mQ9x",
    merchantName: String = "Ada's Bakery",
    title: String = "Birthday cake",
    amountKobo: Int? = 1_500_000,
    description: String? = "Two tiers, vanilla.",
    expiresAt: OffsetDateTime? = null,
) = CheckoutLink(
    code = code,
    merchantName = merchantName,
    title = title,
    description = description,
    amountKobo = amountKobo,
    isReusable = false,
    expiresAt = expiresAt,
)

fun found(link: CheckoutLink = link(), availability: LinkAvailability = LinkAvailability.Payable) =
    LookupOutcome.Found(link, availability)

val payer = PayerInput(amountKobo = 1_500_000, name = "Tunde Bello", email = "tunde@example.com")
