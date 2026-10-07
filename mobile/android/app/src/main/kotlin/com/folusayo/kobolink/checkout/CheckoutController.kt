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
    data class Started(
        val reference: String,
        val amountKobo: Int,
        /** "Start a new payment" was tapped and the phone would not let go of the record: nothing changed, and the screen says so. */
        val startOverFailed: Boolean = false,
    ) : PayPhase

    /** The API refused the request with a reason; the form stays so the payer can correct it. */
    data class Rejected(
        val message: String,
        val fieldErrors: Map<PayerField, String>,
        val moneyMoved: Boolean?,
    ) : PayPhase

    /** A fixed-amount link was repriced after this screen loaded. [newAmountKobo] is null when the new price could not be fetched. */
    data class PriceChanged(val newAmountKobo: Int?) : PayPhase

    /**
     * The call could not be answered (network, rate limit, 5xx), or it was sent in an earlier run of the app and
     * never seen to finish ([FailureKind.Interrupted]). The outcome is UNKNOWN: retrying the same [request] reuses
     * the remembered idempotency key; a changed one is a new attempt.
     */
    data class Failed(val kind: FailureKind, val request: InitializeRequest) : PayPhase

    /**
     * Nothing was sent: the device could not record the attempt first (secure storage unavailable or full), and an
     * unrecorded payment could be made twice. No money was taken; the payer can try again.
     */
    data class NotRecorded(val request: InitializeRequest) : PayPhase
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
 * The link on screen is known to be wrong about its price and the re-read that would fix it failed: the amount it
 * holds is the one the server just refused. Pay must not send it again (it would be refused again, forever), so the
 * screen offers only a reload, and [CheckoutController.pay] ignores taps until a read succeeds.
 */
val PayPhase.needsFreshRead: Boolean get() = this is PayPhase.PriceChanged && newAmountKobo == null

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
 * **One idempotency key per attempt, written down before it is used.** An attempt is one [InitializeRequest]. Its key
 * is created the first time that request is sent and reused for every retry of an identical request, so a double
 * tap, a retry after a timeout, or a second tap after the app was closed replays the server's stored answer instead
 * of creating a second checkout. A different request (the payer corrected the email, or the price changed and was
 * re-read) is a different attempt and gets a fresh key: re-using a key with a changed body is `idempotency_mismatch`.
 *
 * The attempt lives in a [PendingCheckoutStore], not in this object. This object lives in the Activity's ViewModel,
 * and a payer's Done and Back both `finish()` the Activity, as does the system when it kills the process; a key held
 * only here was gone by the next tap, which then made a second pending checkout for one payment. So:
 *
 * - the attempt is saved BEFORE the request leaves (and if it cannot be saved, nothing is sent: [PayPhase.NotRecorded]);
 * - one slot per link code on the device, found whatever the session is doing (every new process starts with the
 *   session still resolving, so a slot keyed by user is not the one a cold start reads), so opening another link
 *   never drops an unsettled attempt;
 * - [open] restores it: the reference is shown again ([PayPhase.Started]), or, if the outcome was never seen (a
 *   failed call, Back mid-request, a killed process), [PayPhase.Failed] with [FailureKind.Interrupted] and the exact
 *   request, so "Try again" resends the identical request under the identical key;
 * - it is cleared only by a definite server refusal with a parsed body (the server stores a refusal under the key
 *   and would replay it to every identical retry, even after the cause is gone), by [startOver] (the payer's own
 *   word that they want a new payment), by the signed-in user's EXPLICIT sign-out ([explicitSignOut]; an expired
 *   session is not one), and when a DIFFERENT user is confirmed ([bindOwner]). A slot carries the id of the user who
 *   made it, only so that another confirmed user neither sees nor resumes it.
 *
 * **A started payment is shown again.** When `initialize` answers, the reference is saved with the attempt. Reopening
 * the link shows the same "Payment started" screen instead of an empty form. It lasts until [startOver] (or, in M4,
 * until `verify` settles it: M4 must clear the slot on EVERY outcome, paid, failed or expired).
 *
 * **A refused price is never sent twice.** After `amount_mismatch` the loaded link still holds the refused amount. If
 * the re-read that would correct it fails, or finds the very amount that was refused, [PayPhase.PriceChanged] has no
 * price and [pay] is ignored until a read succeeds; see [needsFreshRead].
 *
 * Initialize never posts to the ledger (only `verify` does), so a failure here can honestly say that
 * no money has moved, unless the server itself says otherwise ([Rejection.moneyMoved]).
 */
class CheckoutController(
    private val gateway: CheckoutGateway,
    private val scope: CoroutineScope,
    private val store: PendingCheckoutStore = InMemoryPendingCheckoutStore(),
    private val newIdempotencyKey: () -> String = { UUID.randomUUID().toString() },
) {
    private val _state = MutableStateFlow<CheckoutState>(CheckoutState.Idle)
    val state: StateFlow<CheckoutState> = _state.asStateFlow()

    private var generation = 0L
    private var job: Job? = null

    /** The signed-in user the session has CONFIRMED, or null: a payer, a session still resolving, offline or expired. */
    private var confirmedUser: String? = null

    /** The unsettled attempt for the link currently open (or last opened), mirrored in the store. */
    private var held: PendingCheckout? = null

    /**
     * Follow the session: [userId] is the confirmed signed-in user, or null for a payer or a session that is
     * resolving, offline or has ended.
     *
     * Going to null changes nothing: not the cold start's resolving state, and not an expired session (only
     * [explicitSignOut] clears a user's attempts). Becoming a user does two things. Slots made by a DIFFERENT user are
     * cleared, and never shown to this one. And the slot for the open link is read again: the cold start opened it
     * before /me answered, which is the only time a signed-in user's own attempt could be missed.
     */
    fun bindOwner(userId: String?) {
        val previous = confirmedUser
        if (userId == previous) return
        confirmedUser = userId
        if (userId == null) return
        if (previous != null) {
            // Another user straight after one: do not leave the first one's screen up.
            supersede()
            held = null
            _state.value = CheckoutState.Idle
        }
        // A failed clear is not fatal: [visible] hides another user's slot from this one anyway.
        runCatching { store.clearOwnedByOthers(userId) }
        refreshRemembered()
    }

    /**
     * The signed-in user chose to sign out: forget the attempts they made, in memory and on disk, and leave the
     * checkout. A payer's attempts, and those of a session that merely expired, stay.
     */
    fun explicitSignOut() {
        val user = confirmedUser ?: return
        confirmedUser = null
        if (held?.owner == user) held = null
        runCatching { store.clearOwnedBy(user) }
        if (_state.value.isOpen) {
            supersede()
            _state.value = CheckoutState.Idle
        }
    }

    /** Opens [code]: always a fresh lookup, superseding whatever was in flight. */
    fun open(code: String) {
        val mine = supersede()
        held = recall(code)
        _state.value = CheckoutState.Loading(code)
        lookUp(code, mine)
    }

    /** The URL that opened the app held no readable link code: show the not-found screen, not login. */
    fun openUnreadable() {
        supersede()
        held = null
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
     * "Start a new payment": the payer's own word that the remembered payment on the open link is not the one they
     * want (the screen asks them to check with the merchant first, since it may have been paid). Forgets it,
     * in memory and on disk, and looks the link up again. The only way out of a started payment before M4.
     *
     * If the disk will not let go of it, nothing changes and the screen says so ([PayPhase.Started.startOverFailed]):
     * a button that silently does nothing, or that forgets the payment only in memory, would bring it back after a
     * restart.
     */
    fun startOver() {
        val code = _state.value.code ?: return
        if (runCatching { store.save(code, null) }.isFailure) {
            val current = _state.value
            if (current is CheckoutState.Loaded && current.pay is PayPhase.Started) {
                _state.value = current.copy(pay = current.pay.copy(startOverFailed = true))
            }
            return
        }
        held = null
        open(code)
    }

    /**
     * Starts a payment for [input] on the open link. Ignored unless the link is loaded and payable
     * and no attempt is already in flight (a double tap is one request).
     */
    fun pay(input: PayerInput) {
        val loaded = _state.value as? CheckoutState.Loaded ?: return
        if (loaded.availability != LinkAvailability.Payable) return
        if (loaded.pay is PayPhase.Submitting) return
        if (loaded.pay.needsFreshRead) return // the price on screen was just refused; only a fresh read lifts this

        val request = InitializeRequest(
            code = loaded.link.code,
            amountKobo = input.amountKobo,
            payerName = input.name,
            payerEmail = input.email,
        )
        val attempt = attemptFor(request)

        // Write it down BEFORE the request leaves. If the process dies mid-flight the next one knows which key to
        // retry under. If it cannot be written, nothing is sent: an unrecorded payment could be paid twice.
        val recorded = runCatching { store.save(request.code, attempt) }.isSuccess
        if (!recorded) {
            _state.value = loaded.copy(pay = PayPhase.NotRecorded(request))
            return
        }
        held = attempt

        val mine = supersede()
        _state.value = loaded.copy(pay = PayPhase.Submitting)
        job = scope.launch {
            val outcome = gateway.initialize(request, attempt.key)
            if (!isCurrent(mine)) return@launch
            applyInitialize(loaded, attempt, outcome, mine)
        }
    }

    private fun lookUp(code: String, mine: Long) {
        job = scope.launch {
            val outcome = gateway.lookup(code)
            if (!isCurrent(mine)) return@launch
            _state.value = when (outcome) {
                is LookupOutcome.Found -> CheckoutState.Loaded(outcome.link, outcome.availability, rememberedPhaseFor(outcome.link, outcome.availability))
                LookupOutcome.NotFound -> CheckoutState.NotFound(code)
                is LookupOutcome.Failed -> CheckoutState.LoadFailed(code, outcome.kind)
            }
        }
    }

    /**
     * What the form shows for a link just read, given the attempt remembered for it: the same "Payment started"
     * screen, or the interrupted attempt as a retry. Only over a payable link (a link switched off or paid says
     * that instead), and an interrupted attempt only while its price is still the link's price (a changed price is
     * a new request, which has a new key anyway).
     */
    private fun rememberedPhaseFor(link: CheckoutLink, availability: LinkAvailability): PayPhase {
        val remembered = visible(held) ?: return PayPhase.Idle
        if (remembered.request.code != link.code || availability != LinkAvailability.Payable) return PayPhase.Idle
        if (remembered.reference != null) {
            return PayPhase.Started(remembered.reference, remembered.confirmedAmountKobo ?: remembered.request.amountKobo)
        }
        val repriced = link.amountKobo != null && link.amountKobo != remembered.request.amountKobo
        if (repriced) return PayPhase.Idle
        return PayPhase.Failed(FailureKind.Interrupted, remembered.request)
    }

    /**
     * Read the slot for the open link again, now that the user is confirmed. The cold start opened the link while
     * the session was still resolving; a Loaded screen built then is rebuilt here, unless something is in flight or
     * the payer is already past the form (a refusal, a price notice).
     */
    private fun refreshRemembered() {
        val code = _state.value.code ?: return
        val current = _state.value
        if (current is CheckoutState.Loaded) {
            val rebuildable = current.pay is PayPhase.Idle || current.pay is PayPhase.Started ||
                (current.pay is PayPhase.Failed && current.pay.kind == FailureKind.Interrupted)
            if (!rebuildable) return
        }
        held = recall(code)
        if (current is CheckoutState.Loaded) {
            _state.value = current.copy(pay = rememberedPhaseFor(current.link, current.availability))
        }
    }

    /** A slot made by another confirmed user is none of this user's business: neither shown nor resumed. */
    private fun visible(pending: PendingCheckout?): PendingCheckout? {
        val user = confirmedUser
        if (pending == null || user == null || pending.owner == null || pending.owner == user) return pending
        return null
    }

    /** The unsettled attempt for [code]: the one in memory if it is for this link, else the disk's. */
    private fun recall(code: String): PendingCheckout? {
        val remembered = if (held?.request?.code == code) held else runCatching { store.load(code) }.getOrNull()
        return visible(remembered)
    }

    private suspend fun applyInitialize(
        before: CheckoutState.Loaded,
        attempt: PendingCheckout,
        outcome: InitializeOutcome,
        mine: Long,
    ) {
        val request = attempt.request
        when (outcome) {
            is InitializeOutcome.Started -> {
                // The attempt is NOT over: this checkout is pending until M4's verify settles it. Dropping its key
                // here made the next Pay on the same link (reopened while "Payment started" was showing) a second
                // pending checkout for one payment. Kept, an identical Pay replays THIS reference from the server,
                // and reopening the link shows it ([rememberedPhaseFor]). If the reference cannot be saved the
                // key still is, so a retry gets the same reference back from the server.
                val phase = PayPhase.Started(outcome.reference, outcome.amountKobo)
                held = attempt.copy(reference = outcome.reference, confirmedAmountKobo = outcome.amountKobo)
                runCatching { store.save(request.code, held) }
                _state.value = before.copy(pay = phase)
            }

            // Whatever went wrong, a request may have gone out: unknown. The slot stays, and a retry replays it.
            is InitializeOutcome.Failed ->
                _state.value = before.copy(pay = PayPhase.Failed(outcome.kind, request))

            is InitializeOutcome.Rejected -> {
                val rejection = outcome.rejection
                // A refusal is a final answer the server STORES under this key, and replays for as long as the same
                // key and body come back. If the attempt were kept, a link the merchant switches back on would keep
                // answering "turned off" to the identical request. A refusal ends the attempt; the next Pay is new.
                forget(request.code)
                when {
                    rejection.kind == RejectionKind.NotFound ->
                        // Deleted between loading and paying: a form that can never succeed is no place to stay.
                        _state.value = CheckoutState.NotFound(before.link.code)

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
                if (outcome.availability == LinkAvailability.Payable && outcome.link.amountKobo != null) {
                    // The very amount that was just refused is no price to offer: sending it again is the loop.
                    val unchanged = outcome.link.amountKobo == before.link.amountKobo
                    CheckoutState.Loaded(
                        outcome.link,
                        outcome.availability,
                        PayPhase.PriceChanged(if (unchanged) null else outcome.link.amountKobo),
                    )
                } else {
                    CheckoutState.Loaded(outcome.link, outcome.availability)
                }
            LookupOutcome.NotFound -> CheckoutState.NotFound(before.link.code)
            is LookupOutcome.Failed -> before.copy(pay = PayPhase.PriceChanged(newAmountKobo = null))
        }
    }

    /** The attempt to send [request] under: the remembered one if it is the identical request, else a new one. */
    private fun attemptFor(request: InitializeRequest): PendingCheckout {
        val remembered = visible(held)
        if (remembered != null && remembered.request == request) return remembered
        return PendingCheckout(request, newIdempotencyKey(), owner = confirmedUser)
    }

    private fun forget(code: String) {
        held = null
        // A slot that fails to clear comes back as an interrupted attempt; replaying it returns the stored refusal.
        // One retry, since nothing tells the payer about it.
        if (runCatching { store.save(code, null) }.isFailure) runCatching { store.save(code, null) }
    }

    /** Starts a new generation and cancels the previous request. Returns the new generation. */
    private fun supersede(): Long {
        job?.cancel()
        job = null
        return ++generation
    }

    private fun isCurrent(mine: Long) = mine == generation
}
