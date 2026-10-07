package com.folusayo.kobolink.checkout

import java.time.OffsetDateTime
import kotlinx.coroutines.CompletableDeferred

/** One call the checkout made, held open until the test decides how it ends. */
class PendingCall<Q, R>(val request: Q) {
    val answer = CompletableDeferred<R>()
    fun complete(result: R) {
        answer.complete(result)
    }
}

/**
 * A gateway whose calls stay in flight until a test completes them, so a test can finish them in any order. That is
 * the whole point: a latest-wins bug is only visible when the old answer arrives after the new one.
 * It deliberately ignores cancellation (an awaited [CompletableDeferred] is cancellable, but a test can also complete
 * a call the controller already abandoned): the controller must not rely on cancellation alone.
 */
class FakeCheckoutGateway : CheckoutGateway {
    val lookups = mutableListOf<PendingCall<String, LookupOutcome>>()
    val initializes = mutableListOf<PendingCall<Pair<InitializeRequest, String>, InitializeOutcome>>()

    override suspend fun lookup(code: String): LookupOutcome {
        val call = PendingCall<String, LookupOutcome>(code)
        lookups += call
        return call.answer.await()
    }

    override suspend fun initialize(request: InitializeRequest, idempotencyKey: String): InitializeOutcome {
        val call = PendingCall<Pair<InitializeRequest, String>, InitializeOutcome>(request to idempotencyKey)
        initializes += call
        return call.answer.await()
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
