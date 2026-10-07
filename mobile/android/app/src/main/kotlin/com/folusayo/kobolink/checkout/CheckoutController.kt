package com.folusayo.kobolink.checkout

import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** What the checkout screen is showing. */
sealed interface CheckoutState {
    /** No link open: a launcher start, or the payer closed the checkout. */
    data object Idle : CheckoutState

    /** Looking the link up. Shown as a skeleton in the shape of the content. */
    data class Loading(val code: String) : CheckoutState

    /** The API has no such link, or the URL held no readable code at all ([code] is null then). */
    data class NotFound(val code: String?) : CheckoutState

    /** The link could not be looked up. Nothing is known about it, and nothing has been charged. */
    data class LoadFailed(val code: String, val kind: FailureKind) : CheckoutState

    /** The link, and whether it can be paid. [pay] only matters while [availability] is [LinkAvailability.Payable]. */
    data class Loaded(
        val link: CheckoutLink,
        val availability: LinkAvailability,
        val pay: PayPhase = PayPhase.Idle,
    ) : CheckoutState
}

/** Where a Pay attempt is. Pay only ever calls `initialize`; verifying the payment is M4's. */
sealed interface PayPhase {
    data object Idle : PayPhase

    /** The request is in flight. Pay is disabled; a second tap is ignored. */
    data object Submitting : PayPhase

    /**
     * `initialize` answered with a pending checkout. **This is the M3 to M4 hand-off.** The contract
     * returns a `reference` and nothing to redirect to (no authorization URL: the gateway is
     * simulated and `verify` decides the outcome), so what M4 needs is exactly this: the reference
     * to verify. Nothing has been charged yet.
     */
    data class Started(val reference: String, val amountKobo: Int) : PayPhase

    /** The API refused the request with a reason; the form stays so the payer can correct it. */
    data class Rejected(
        val message: String,
        val fieldErrors: Map<PayerField, String>,
        val moneyMoved: Boolean?,
    ) : PayPhase

    /** A fixed-amount link was repriced after this screen loaded. [newAmountKobo] is null when the new price could not be fetched. */
    data class PriceChanged(val newAmountKobo: Int?) : PayPhase

    /** The call could not be answered (network, rate limit, 5xx). Retrying reuses the held idempotency key. */
    data class Failed(val kind: FailureKind) : PayPhase
}

/** The code of the link this state is about, or null when none is open or it was unreadable. */
val CheckoutState.code: String?
    get() = when (this) {
        CheckoutState.Idle -> null
        is CheckoutState.Loading -> code
        is CheckoutState.NotFound -> code
        is CheckoutState.LoadFailed -> code
        is CheckoutState.Loaded -> link.code
    }

val CheckoutState.isOpen: Boolean get() = this !is CheckoutState.Idle

/**
 * Every decision the checkout makes, as plain Kotlin with no Android types, so it runs in JVM unit
 * tests: [com.folusayo.kobolink.MainViewModel] owns one across Activity recreation and only
 * supplies [scope]. Same shape as `SessionController`.
 *
 * **Latest wins.** Every [open], [reload], [pay] and [close] starts a new generation and cancels the
 * previous request; a response is applied only if its generation is still current. Cancellation
 * alone would not be enough: a response that has already been delivered when the newer request
 * starts is stale the instant it arrives, and nothing cancels it. This is what makes a late answer
 * for link A unable to overwrite the screen for link B, and a payment answer unable to land on a
 * link the payer has since left (M1 review, item b).
 *
 * **Re-tap re-runs.** [open] always performs a lookup, even for the code already on screen, even if
 * that code was already resolved or had failed offline (M1 review, item a). The M1 screen keyed its
 * effect on the code string, so tapping the same link twice changed nothing and so did nothing.
 *
 * **One idempotency key per attempt.** An attempt is one [InitializeRequest]. Its key is created
 * the first time that request is sent and reused for every retry of an identical request, so a
 * double tap, a retry after a timeout, or a second tap after the app was backgrounded replays the
 * server's stored answer instead of creating a second checkout. A different request (the payer
 * corrected the email) is a different attempt and gets a fresh key: re-using a key with a changed
 * body is `idempotency_mismatch`. The key survives a failed call (nothing was stored, so a retry is
 * safe), a success, [close] and a re-[open] of the same link, and is dropped when a different link is
 * opened or when the server refuses the request: the server stores a refusal under the key and would
 * replay it to every identical retry, including after the cause (a link switched back on) is gone.
 *
 * Initialize never posts to the ledger (only `verify` does), so a failure here can honestly say that
 * no money has moved, unless the server itself says otherwise ([Rejection.moneyMoved]).
 */
class CheckoutController(
    private val gateway: CheckoutGateway,
    private val scope: CoroutineScope,
    private val newIdempotencyKey: () -> String = { UUID.randomUUID().toString() },
) {
    private val _state = MutableStateFlow<CheckoutState>(CheckoutState.Idle)
    val state: StateFlow<CheckoutState> = _state.asStateFlow()

    private var generation = 0L
    private var job: Job? = null
    private var attempt: Attempt? = null

    private data class Attempt(val request: InitializeRequest, val key: String)

    /** Opens [code]: always a fresh lookup, superseding whatever was in flight. */
    fun open(code: String) {
        val mine = supersede()
        if (attempt?.request?.code != code) attempt = null
        _state.value = CheckoutState.Loading(code)
        lookUp(code, mine)
    }

    /** The URL that opened the app held no readable link code: show the not-found screen, not login. */
    fun openUnreadable() {
        supersede()
        attempt = null
        _state.value = CheckoutState.NotFound(code = null)
    }

    /** "Try again" / "Check again": re-runs the lookup for the link on screen. */
    fun reload() {
        val code = _state.value.code ?: return
        open(code)
    }

    /** Leaves the checkout. Cancels anything in flight; its answer can no longer land. */
    fun close() {
        supersede()
        _state.value = CheckoutState.Idle
    }

    /**
     * Starts a payment for [input] on the open link. Ignored unless the link is loaded and payable
     * and no attempt is already in flight (a double tap is one request).
     */
    fun pay(input: PayerInput) {
        val loaded = _state.value as? CheckoutState.Loaded ?: return
        if (loaded.availability != LinkAvailability.Payable) return
        if (loaded.pay is PayPhase.Submitting) return

        val request = InitializeRequest(
            code = loaded.link.code,
            amountKobo = input.amountKobo,
            payerName = input.name,
            payerEmail = input.email,
        )
        val key = keyFor(request)

        val mine = supersede()
        _state.value = loaded.copy(pay = PayPhase.Submitting)
        job = scope.launch {
            val outcome = gateway.initialize(request, key)
            if (!isCurrent(mine)) return@launch
            applyInitialize(loaded, outcome, mine)
        }
    }

    private fun lookUp(code: String, mine: Long) {
        job = scope.launch {
            val outcome = gateway.lookup(code)
            if (!isCurrent(mine)) return@launch
            _state.value = when (outcome) {
                is LookupOutcome.Found -> CheckoutState.Loaded(outcome.link, outcome.availability)
                LookupOutcome.NotFound -> CheckoutState.NotFound(code)
                is LookupOutcome.Failed -> CheckoutState.LoadFailed(code, outcome.kind)
            }
        }
    }

    private suspend fun applyInitialize(before: CheckoutState.Loaded, outcome: InitializeOutcome, mine: Long) {
        when (outcome) {
            is InitializeOutcome.Started ->
                _state.value = before.copy(pay = PayPhase.Started(outcome.reference, outcome.amountKobo))

            is InitializeOutcome.Failed ->
                _state.value = before.copy(pay = PayPhase.Failed(outcome.kind))

            is InitializeOutcome.Rejected -> {
                val rejection = outcome.rejection
                // A refusal is a final answer the server STORES under this key, and replays for as long as the same
                // key and body come back. If the attempt were kept, a link the merchant switches back on would keep
                // answering "turned off" to the identical request. A refusal ends the attempt; the next Pay is new.
                attempt = null
                when {
                    rejection.kind == RejectionKind.LinkNotPayable ->
                        // Lost a race with the merchant (switched off, expired) or another payer (single use).
                        _state.value = before.copy(
                            availability = rejection.availability ?: LinkAvailability.Unknown,
                            pay = PayPhase.Idle,
                        )

                    rejection.kind == RejectionKind.AmountMismatch && before.link.amountKobo != null ->
                        // The merchant repriced a fixed-amount link after this screen loaded. Resubmitting
                        // cannot succeed; read the link again so the payer is told the current price.
                        reportPriceChanged(before, mine)

                    else -> {
                        val fieldErrors = if (rejection.kind == RejectionKind.AmountMismatch) {
                            // An open-amount link: the typed amount was refused, plain field validation.
                            rejection.fieldErrors + (PayerField.Amount to rejection.message)
                        } else {
                            rejection.fieldErrors
                        }
                        _state.value = before.copy(
                            pay = PayPhase.Rejected(rejection.message, fieldErrors, rejection.moneyMoved),
                        )
                    }
                }
            }
        }
    }

    private suspend fun reportPriceChanged(before: CheckoutState.Loaded, mine: Long) {
        val outcome = gateway.lookup(before.link.code)
        if (!isCurrent(mine)) return
        _state.value = when (outcome) {
            is LookupOutcome.Found ->
                if (outcome.availability == LinkAvailability.Payable) {
                    CheckoutState.Loaded(outcome.link, outcome.availability, PayPhase.PriceChanged(outcome.link.amountKobo))
                } else {
                    CheckoutState.Loaded(outcome.link, outcome.availability)
                }
            LookupOutcome.NotFound -> CheckoutState.NotFound(before.link.code)
            is LookupOutcome.Failed -> before.copy(pay = PayPhase.PriceChanged(newAmountKobo = null))
        }
    }

    private fun keyFor(request: InitializeRequest): String {
        val held = attempt
        if (held != null && held.request == request) return held.key
        return newIdempotencyKey().also { attempt = Attempt(request, it) }
    }

    /** Starts a new generation and cancels the previous request. Returns the new generation. */
    private fun supersede(): Long {
        job?.cancel()
        job = null
        return ++generation
    }

    private fun isCurrent(mine: Long) = mine == generation
}
