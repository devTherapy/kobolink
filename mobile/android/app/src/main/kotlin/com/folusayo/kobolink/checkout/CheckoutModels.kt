package com.folusayo.kobolink.checkout

import java.time.OffsetDateTime

/**
 * What the checkout renders, decoupled from the generated OpenAPI classes.
 *
 * The generated `PublicLinkResponse` is a `HashMap` subclass (a quirk of the
 * generator's handling of the response schema) and carries enum constants named
 * `alreadyMinusPaid`. Mapping it once, in [ApiCheckoutGateway], keeps both out of
 * the state machine, the screen and the tests. The money field stays what the
 * contract says it is: integer kobo.
 */
data class CheckoutLink(
    val code: String,
    val merchantName: String,
    val title: String,
    val description: String?,
    /** Integer kobo, or null when the payer chooses the amount. Never naira. */
    val amountKobo: Int?,
    val isReusable: Boolean,
    val expiresAt: OffsetDateTime?,
)

/**
 * Whether the link can be paid, as the server resolved it. `PublicLinkState` in
 * the contract plus [Unknown]: a `link_not_payable` rejection that did not say
 * which state, which the screen words neutrally rather than guessing.
 */
enum class LinkAvailability { Payable, Disabled, Expired, AlreadyPaid, Unknown }

/** Why a call could not be answered at all. Every case is retryable. */
enum class FailureKind {
    /** The request never completed: no connection, timeout, DNS. */
    Network,

    /** HTTP 429. */
    RateLimited,

    /** A 5xx, or a non-JSON error body (a proxy's 502 page). */
    Server,

    /** A 2xx whose body this app could not read. */
    Unreadable,
}

sealed interface LookupOutcome {
    data class Found(val link: CheckoutLink, val availability: LinkAvailability) : LookupOutcome

    /** The API said `not_found`: the code is well-formed but names no link. */
    data object NotFound : LookupOutcome

    data class Failed(val kind: FailureKind) : LookupOutcome
}

/** The three things a payer types. Server-side validation errors are keyed by these. */
enum class PayerField { Amount, Name, Email }

/** A payer's validated input; see [validatePayer]. [amountKobo] is integer kobo. */
data class PayerInput(val amountKobo: Int, val name: String, val email: String)

enum class RejectionKind {
    /** `link_not_payable`: the link stopped being payable between loading and paying. */
    LinkNotPayable,

    /** `amount_mismatch`. */
    AmountMismatch,

    /** `validation_failed`. */
    ValidationFailed,

    /** Anything else the API answered with a body: not_found, rate_limited, idempotency_mismatch, internal... */
    Other,
}

/**
 * A definitive answer from the API that the request was refused. [moneyMoved] is
 * the server's own statement when it made one; null means it said nothing.
 */
data class Rejection(
    val kind: RejectionKind,
    val message: String,
    val fieldErrors: Map<PayerField, String> = emptyMap(),
    val moneyMoved: Boolean? = null,
    /** Set for [RejectionKind.LinkNotPayable] when the server named the state. */
    val availability: LinkAvailability? = null,
)

/** The request `POST /api/checkout/initialize` carries; also what an idempotency key is bound to. */
data class InitializeRequest(
    val code: String,
    val amountKobo: Int,
    val payerName: String,
    val payerEmail: String,
)

sealed interface InitializeOutcome {
    /** The API created a pending checkout. Nothing has been charged: only `verify` posts to the ledger. */
    data class Started(val reference: String, val amountKobo: Int) : InitializeOutcome

    data class Rejected(val rejection: Rejection) : InitializeOutcome

    data class Failed(val kind: FailureKind) : InitializeOutcome
}
