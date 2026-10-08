package com.folusayo.kobolink.checkout

import com.folusayo.kobolink.auth.AuthenticatedUser
import com.folusayo.kobolink.auth.SessionChange
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

    /**
     * Secure storage would not tell us, or would not let go of, an earlier attempt for this link (or the record of
     * what a sign-out owes), so the link cannot be paid until it does: guessing could send a second payment or show
     * someone else's. A saved attempt was written before its request left, so this never says nothing was sent.
     */
    data class StorageBlocked(val code: String, val block: StorageBlock) : CheckoutState

    /** The link, and whether it can be paid. [pay] only matters while [availability] is [LinkAvailability.Payable]. */
    data class Loaded(
        val link: CheckoutLink,
        val availability: LinkAvailability,
        val pay: PayPhase = PayPhase.Idle,
    ) : CheckoutState
}

/** Why a link is blocked by storage. */
enum class StorageBlock {
    /** Secure storage could not be read, so it is not known whether a payment was started on this link. */
    Unreadable,

    /** There is a record for this link that this build cannot read. "Start a new payment" removes it. */
    Undecodable,

    /** "Start a new payment" was confirmed on an unreadable record and storage would not remove it: nothing changed. */
    UndecodableClearFailed,

    /**
     * The record of what a sign-out owes is there and this build cannot make sense of it. Nothing may be shown until
     * it is known, so the only way out is to reset the checkout data on this device.
     */
    ObligationUnreadable,

    /** "Reset checkout data" was confirmed and storage would not let go: nothing changed. */
    ResetFailed,

    /** An attempt belonging to an earlier session could not be removed, so it is not shown. */
    CannotClear,
}

/** Where a Pay attempt is. Pay only ever calls `initialize`; verifying the payment is M4's. */
sealed interface PayPhase {
    data object Idle : PayPhase

    /** The request is in flight. Pay is disabled; a second tap is ignored. */
    data object Submitting : PayPhase

    /**
     * A REMEMBERED attempt is being sent again (the same request under the same key; [CheckoutController.retry]).
     * The form was never filled in this run, so the screen shows the attempt, not a form: it needs only the amount.
     */
    data class Retrying(val amountKobo: Int) : PayPhase

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
     *
     * A remembered attempt ([isRemembered]) is shown as an ATTEMPT, never as a form: its name and e-mail are only
     * ever sent again, never put back on a screen, because the person looking at it may not be the person who made it.
     */
    data class Failed(
        val kind: FailureKind,
        val request: InitializeRequest,
        /** "Start a new payment" was tapped and the phone would not let go of the record: nothing changed, and the screen says so. */
        val startOverFailed: Boolean = false,
        /** This is a remembered attempt that was sent again from its own screen and still has no answer. */
        val resumed: Boolean = false,
    ) : PayPhase

    /**
     * Nothing was sent: the device could not record the attempt first (secure storage unavailable or full), and an
     * unrecorded payment could be made twice. No money was taken; the payer can try again.
     */
    data class NotRecorded(val request: InitializeRequest) : PayPhase
}

/** An attempt restored from storage (or resent from its screen), not one the payer just typed: no form is shown for it. */
val PayPhase.Failed.isRemembered: Boolean get() = resumed || kind == FailureKind.Interrupted

/** A request is in flight, so a second tap is ignored. */
val PayPhase.isBusy: Boolean get() = this is PayPhase.Submitting || this is PayPhase.Retrying

/** The screen for a remembered attempt, as opposed to the form: [PayPhase.Failed.isRemembered] or being resent. */
val PayPhase.showsAttempt: Boolean get() = (this is PayPhase.Failed && isRemembered) || this is PayPhase.Retrying

/** The code of the link this state is about, or null when none is open or it was unreadable. */
val CheckoutState.code: String?
    get() = when (this) {
        CheckoutState.Idle -> null
        is CheckoutState.Loading -> code
        is CheckoutState.NotFound -> code
        is CheckoutState.LoadFailed -> code
        is CheckoutState.StorageBlocked -> code
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
 * **Latest wins.** Every [open], [reload], [pay], [retry] and [close] starts a new generation and cancels the
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
 *   failed call, Back mid-request, a killed process), [PayPhase.Failed] with [FailureKind.Interrupted]; "Try again"
 *   ([retry]) resends the exact stored request under the stored key;
 * - it is cleared only by a definite server refusal with a parsed body (the server stores a refusal under the key
 *   and would replay it to every identical retry, even after the cause is gone), by [startOver] (the payer's own
 *   word that they want a new payment, after a confirmation), and by the rules of [AttemptOwner] below.
 *
 * ## Ownership (the iOS I3 rule, see [AttemptOwner])
 *
 * An attempt is a payer's (made with no stored session) or a session's (made while signed in, resolving or offline;
 * its user id is filled in once `/me` confirms it). [sessionDidChange] applies the rule and nothing else touches
 * ownership:
 *
 * - **explicit sign-out** removes every session attempt on the device, through a persisted [SignOutObligation] that
 *   [prepareSignOut] writes BEFORE the sign-out. If it cannot be written the sign-out does not happen. The
 *   obligation is read before anything else a session event does, and hides what it names until the removal
 *   succeeds. It names (link code, idempotency key), never a time. A payer's attempt is never removed by it;
 * - **a confirmed user** adopts the attempts with no user id and removes the ones another confirmed user made;
 * - **a sign-in** adopts too and never drops an unconfirmed attempt (it may be the same person's, outcome unknown);
 * - **an involuntary end** (401, expiry) removes nothing;
 * - an obligation that cannot be read blocks every link ([StorageBlock.ObligationUnreadable]); the only exit is
 *   [resetCheckoutData], which the screen asks the person to confirm.
 *
 * Every one of those events also empties the payer form synchronously, in memory ([clearForm]): the name, e-mail and
 * amount of whoever was here are not for whoever is here next.
 *
 * **Privacy.** A stored name or e-mail is never put on a screen. A remembered attempt is shown as an attempt (merchant,
 * amount, reference) with no fields; "Start a new payment" opens an EMPTY form; the names are only sent again, in a
 * same-key retry. Known limits: a payer's slot is per device, so two payers on one phone share it; every slot
 * survives a reinstall of the app only if the platform backs it up (it is excluded from backup, so it does not).
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
    /** Who an attempt started right now belongs to; see [AttemptOwner]. */
    private val ownerNow: () -> AttemptOwner = { AttemptOwner.Payer },
    /** Empties the payer form (name, e-mail, amount, errors). Called synchronously by every event that must. */
    private val clearForm: () -> Unit = {},
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
     * What a sign-out still owes the device. It is written to storage BEFORE the sign-out, read again by a new
     * process BEFORE anything else a session event does (a merge or an adoption without it would overwrite or
     * relabel what it names), and hides what it names until the removal succeeds.
     */
    private var owed: SignOutObligation? = null
    private var obligationLoaded = false

    /** Set when a sign-out could not be prepared in time: every session attempt is hidden until it can be. */
    private var hideSessionAttempts = false

    /** A user whose adoption of unconfirmed attempts could not be saved; retried the next time a link is shown. */
    private var pendingAdoption: String? = null

    // ---- opening and closing ----------------------------------------------------------------------------------

    /** Opens [code]: always a fresh lookup, superseding whatever was in flight. Opening a different link empties the form. */
    fun open(code: String) {
        val mine = supersede()
        if (_state.value.code != code) {
            clearForm()
            held = null
        }
        present(code, mine)
    }

    /** The URL that opened the app held no readable link code: show the not-found screen, not login. */
    fun openUnreadable() {
        supersede()
        held = null
        clearForm()
        _state.value = CheckoutState.NotFound(code = null)
    }

    /** "Try again" / "Check again": re-runs the lookup for the link on screen. */
    fun reload() {
        val code = _state.value.code ?: return
        open(code)
    }

    /** Leaves the checkout. Cancels anything in flight (its answer can no longer land) and empties the form, so Back never lands on a stale one. */
    fun close() {
        supersede()
        held = null
        clearForm()
        _state.value = CheckoutState.Idle
    }

    /**
     * "Start a new payment", after the person confirmed: forget the remembered attempt, in memory and on disk, and
     * look the link up again. The form opens EMPTY: what the earlier attempt held (a name and an e-mail) is never
     * shown to whoever is holding the phone, only sent again in a same-key retry. Also the exit from an unreadable
     * record ([StorageBlock.Undecodable]).
     *
     * If the disk will not let go of it, nothing changes and the screen says so ([PayPhase.Started.startOverFailed]):
     * a button that silently does nothing, or that forgets the payment only in memory, would bring it back after a
     * restart.
     */
    fun startOver() {
        val current = _state.value
        val code = current.code ?: return
        val removable = when (current) {
            is CheckoutState.StorageBlocked ->
                current.block == StorageBlock.Undecodable || current.block == StorageBlock.UndecodableClearFailed
            is CheckoutState.Loaded -> current.pay is PayPhase.Started || current.pay is PayPhase.Failed
            else -> false
        }
        if (!removable) return
        try {
            store.remove(code)
        } catch (e: PendingStoreException) {
            when {
                current is CheckoutState.StorageBlocked ->
                    _state.value = current.copy(block = StorageBlock.UndecodableClearFailed)
                current is CheckoutState.Loaded && current.pay is PayPhase.Started ->
                    _state.value = current.copy(pay = current.pay.copy(startOverFailed = true))
                current is CheckoutState.Loaded && current.pay is PayPhase.Failed ->
                    _state.value = current.copy(pay = current.pay.copy(startOverFailed = true))
            }
            return
        }
        clearForm()
        held = null
        open(code)
    }

    // ---- paying ------------------------------------------------------------------------------------------------

    /**
     * Starts a payment for [input] on the open link. Ignored unless the link is loaded and payable
     * and no attempt is already in flight (a double tap is one request).
     */
    fun pay(input: PayerInput) {
        val loaded = _state.value as? CheckoutState.Loaded ?: return
        if (loaded.availability != LinkAvailability.Payable) return
        if (loaded.pay.isBusy) return
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
        val recorded = try {
            store.save(attempt)
            true
        } catch (e: PendingStoreException) {
            false
        }
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
            applyInitialize(loaded, attempt, outcome, mine, resumed = false)
        }
    }

    /**
     * "Try again" on a REMEMBERED attempt of unknown outcome: the SAME request under the SAME key, taken from the
     * stored attempt, not from the form (which is empty). Nothing is written first (the key is already stored), so a
     * storage failure cannot turn a replay into a new attempt, and nothing the server says about this replay alone
     * can end the attempt except the refusals [applyInitialize] lists.
     */
    fun retry() {
        val loaded = _state.value as? CheckoutState.Loaded ?: return
        val pay = loaded.pay as? PayPhase.Failed ?: return
        if (loaded.availability != LinkAvailability.Payable) return
        val attempt = held ?: return
        if (attempt.request.code != loaded.link.code || isHidden(attempt) || ownedByAnotherUser(attempt)) return
        if (pay.request != attempt.request) return

        val mine = supersede()
        _state.value = loaded.copy(pay = PayPhase.Retrying(attempt.request.amountKobo))
        job = scope.launch {
            val outcome = gateway.initialize(attempt.request, attempt.key)
            if (!isCurrent(mine)) return@launch
            applyInitialize(loaded, attempt, outcome, mine, resumed = true)
        }
    }

    // ---- lookup ------------------------------------------------------------------------------------------------

    /**
     * Decide what [code] shows: a block, or its remembered attempt over a fresh lookup. What a previous process owed
     * comes first: until it is known, no slot may be shown.
     */
    private fun present(code: String, mine: Long) {
        when (loadObligationOnce()) {
            ObligationRead.Ok -> Unit
            ObligationRead.Unavailable -> return block(code, StorageBlock.Unreadable)
            ObligationRead.Undecodable -> return block(code, StorageBlock.ObligationUnreadable)
        }
        runOwed()
        pendingAdoption?.let { adoptUnconfirmed(it) }

        val slot = try {
            store.load(code)
        } catch (e: PendingStoreException) {
            return block(code, if (e.kind == StoreFailureKind.Undecodable) StorageBlock.Undecodable else StorageBlock.Unreadable)
        }
        if (slot == null) {
            held = null
        } else if (isHidden(slot)) {
            // An earlier session's attempt that could not be removed: never shown, never resumed.
            return block(code, StorageBlock.CannotClear)
        } else if (ownedByAnotherUser(slot)) {
            // Another CONFIRMED user's attempt is never shown to this one: remove it, or if that fails, hide it.
            held = null
            try {
                store.remove(code)
            } catch (e: PendingStoreException) {
                return block(code, StorageBlock.CannotClear)
            }
        } else {
            held = withAnswerInMemory(slot)
        }
        _state.value = CheckoutState.Loading(code)
        lookUp(code, mine)
    }

    private fun block(code: String, block: StorageBlock) {
        held = null
        _state.value = CheckoutState.StorageBlocked(code, block)
    }

    /** The answer may be in memory even if writing it down failed. */
    private fun withAnswerInMemory(slot: PendingCheckout): PendingCheckout {
        val memory = held
        if (memory != null && memory.key == slot.key && slot.reference == null && memory.reference != null) {
            return slot.copy(reference = memory.reference, confirmedAmountKobo = memory.confirmedAmountKobo)
        }
        return slot
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
     * What the screen shows for a link just read, given the attempt remembered for it: the same "Payment started"
     * screen, or the interrupted attempt as a retry. Only over a payable link (a link switched off or paid says
     * that instead), and an interrupted attempt only while its price is still the link's price (a changed price is
     * a new request, which has a new key anyway).
     */
    private fun rememberedPhaseFor(link: CheckoutLink, availability: LinkAvailability): PayPhase {
        val remembered = held?.takeIf { !isHidden(it) && !ownedByAnotherUser(it) } ?: return PayPhase.Idle
        if (remembered.request.code != link.code || availability != LinkAvailability.Payable) return PayPhase.Idle
        if (remembered.reference != null) {
            return PayPhase.Started(remembered.reference, remembered.confirmedAmountKobo ?: remembered.request.amountKobo)
        }
        val repriced = link.amountKobo != null && link.amountKobo != remembered.request.amountKobo
        if (repriced) return PayPhase.Idle
        return PayPhase.Failed(FailureKind.Interrupted, remembered.request)
    }

    // ---- an answer ---------------------------------------------------------------------------------------------

    private suspend fun applyInitialize(
        before: CheckoutState.Loaded,
        attempt: PendingCheckout,
        outcome: InitializeOutcome,
        mine: Long,
        resumed: Boolean,
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
                val answered = attempt.copy(reference = outcome.reference, confirmedAmountKobo = outcome.amountKobo)
                held = answered
                try {
                    store.save(answered)
                } catch (e: PendingStoreException) {
                    // Kept in memory, and the key is on disk already.
                }
                _state.value = before.copy(pay = phase)
            }

            // Whatever went wrong, a request may have gone out: unknown. The slot stays, and a retry replays it.
            is InitializeOutcome.Failed ->
                _state.value = before.copy(pay = PayPhase.Failed(outcome.kind, request, resumed = resumed))

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
        val remembered = held?.takeIf { !isHidden(it) && !ownedByAnotherUser(it) }
        if (remembered != null && remembered.request == request) return remembered
        return PendingCheckout(request, newIdempotencyKey(), owner = ownerNow())
    }

    private fun forget(code: String) {
        held = null
        // A slot that fails to clear comes back as an interrupted attempt; replaying it returns the stored refusal.
        // One retry, since nothing tells the payer about it.
        try {
            store.remove(code)
        } catch (e: PendingStoreException) {
            try {
                store.remove(code)
            } catch (again: PendingStoreException) {
                // Left in place: see above.
            }
        }
    }

    // ---- the session -------------------------------------------------------------------------------------------

    /**
     * Whether any attempt made under a session is stored, for the sign-out confirmation. Storage that cannot be
     * listed counts as "yes": the safe answer is to ask.
     */
    val hasSessionAttempts: Boolean
        get() = try {
            store.all().any { slot ->
                when (slot) {
                    is PendingSlot.Pending -> slot.pending.owner.isSession
                    is PendingSlot.Unreadable -> true
                }
            }
        } catch (e: PendingStoreException) {
            true
        }

    /**
     * Asked by the session BEFORE it signs the person out. It writes down what the sign-out owes (every session
     * attempt and unreadable slot on the device, by identity) and returns true only when that is safely stored, or
     * when nothing is owed. False means the sign-out must not happen: a sign-out whose clearing could be forgotten
     * by a restart would show this person's attempt to whoever holds the phone.
     */
    fun prepareSignOut(): Boolean {
        if (loadObligationOnce() != ObligationRead.Ok) return false
        val slots = try {
            store.all()
        } catch (e: PendingStoreException) {
            return false
        }
        val entries = owed?.entries.orEmpty().toMutableList()
        for (slot in slots) {
            when (slot) {
                is PendingSlot.Pending ->
                    if (slot.pending.owner.isSession) entries += SignOutObligation.Entry(slot.pending.request.code, slot.pending.key)
                is PendingSlot.Unreadable -> entries += SignOutObligation.Entry(slot.slotId, null)
            }
        }
        val unique = entries.distinct()
        if (unique.isEmpty()) {
            hideSessionAttempts = false
            return true
        }
        val obligation = SignOutObligation(unique)
        try {
            store.saveObligation(obligation)
        } catch (e: PendingStoreException) {
            return false
        }
        owed = obligation
        hideSessionAttempts = false
        return true
    }

    /** React to a change in who is signed in; [AttemptOwner] states the rule. */
    fun sessionDidChange(change: SessionChange) {
        when (change) {
            // An involuntary end says nothing about who is holding the phone: nothing is forgotten.
            SessionChange.Ended -> return

            SessionChange.SignedOutByChoice -> {
                confirmedUser = null
                pendingAdoption = null
                // The session asked first ([prepareSignOut]), so this is normally a repeat. If it cannot be made
                // safe now, every session attempt is hidden until it can be.
                if (!prepareSignOut()) hideSessionAttempts = true
                runOwed()
                resetOpenScreen()
            }

            is SessionChange.Resolved -> {
                val previous = confirmedUser
                confirmedUser = change.user.id
                settle(change.user)
                // Another user than the last one, or an attempt on screen that has just been removed: do not leave it up.
                if ((previous != null && previous != change.user.id) || heldIsGone()) resetOpenScreen()
            }

            is SessionChange.SignedIn -> {
                // A sign-in NEVER drops an attempt whose owner was not confirmed: it may be the same person's, with an
                // outcome nobody has seen, and forgetting it would let the form mint a second key. The person who
                // signs in adopts it, unless a sign-out owes its removal. Only another CONFIRMED user's are removed.
                confirmedUser = change.user.id
                settle(change.user)
                resetOpenScreen()
            }
        }
    }

    /**
     * What follows a confirmed user, in this order: what a previous sign-out owed is read FIRST (an adoption before
     * it would relabel an attempt it names), then carried out, then other users' attempts go, then the unconfirmed
     * ones are adopted. If the obligation cannot be read, nothing here proceeds, and adoption waits.
     */
    private fun settle(user: AuthenticatedUser) {
        if (loadObligationOnce() != ObligationRead.Ok) {
            pendingAdoption = user.id
            return
        }
        runOwed()
        val slots = try {
            store.all()
        } catch (e: PendingStoreException) {
            emptyList()
        }
        for (slot in slots) {
            val pending = (slot as? PendingSlot.Pending)?.pending ?: continue
            val owner = pending.owner
            if (owner is AttemptOwner.Session && owner.userId != null && owner.userId != user.id) {
                try {
                    store.remove(pending.request.code)
                } catch (e: PendingStoreException) {
                    // Still stored: [present] hides it from this user and tries again.
                }
            }
        }
        adoptUnconfirmed(user.id)
    }

    /** Is the attempt on screen no longer what the store holds (removed by a cleanup, or replaced)? */
    private fun heldIsGone(): Boolean {
        val attempt = held ?: return false
        return try {
            store.load(attempt.request.code)?.key != attempt.key
        } catch (e: PendingStoreException) {
            true
        }
    }

    /**
     * Empty everything that belongs to the person who was here, and show the open link again as it looks to whoever
     * is here now. A request still in the air is abandoned (its answer can no longer land): the attempt, if it is
     * still stored, comes back as an interrupted one and is retried under its own key.
     */
    private fun resetOpenScreen() {
        clearForm()
        held = null
        val code = _state.value.code ?: return
        val mine = supersede()
        present(code, mine)
    }

    private enum class ObligationRead { Ok, Unavailable, Undecodable }

    /**
     * Reads what a previous process owed. A throw is "could not find out", and then no slot is shown and nothing is
     * merged or saved: guessing "nothing owed" could show a signed-out person's attempt, or overwrite the record.
     */
    private fun loadObligationOnce(): ObligationRead {
        if (obligationLoaded) return ObligationRead.Ok
        return try {
            owed = store.loadObligation()
            obligationLoaded = true
            ObligationRead.Ok
        } catch (e: PendingStoreException) {
            if (e.kind == StoreFailureKind.Undecodable) ObligationRead.Undecodable else ObligationRead.Unavailable
        }
    }

    /** Is this attempt one a sign-out owes the removal of (or one hidden because a sign-out could not be prepared)? */
    private fun isHidden(pending: PendingCheckout): Boolean {
        if (owed?.contains(pending.request.code, pending.key) == true) return true
        return hideSessionAttempts && pending.owner.isSession
    }

    /** Another CONFIRMED user's attempt is none of this user's business: neither shown nor resumed. */
    private fun ownedByAnotherUser(pending: PendingCheckout): Boolean {
        val me = confirmedUser ?: return false
        val owner = pending.owner
        return owner is AttemptOwner.Session && owner.userId != null && owner.userId != me
    }

    /**
     * Remove what a sign-out owes. A removal that fails leaves the obligation in place (it keeps hiding what it
     * names); it is never swallowed.
     */
    private fun runOwed() {
        val current = owed ?: return
        val slots = try {
            store.all()
        } catch (e: PendingStoreException) {
            return
        }
        var complete = true
        for (slot in slots) {
            val (id, key) = when (slot) {
                is PendingSlot.Pending -> slot.pending.request.code to slot.pending.key
                is PendingSlot.Unreadable -> slot.slotId to null
            }
            if (!current.contains(id, key)) continue
            try {
                store.remove(id)
            } catch (e: PendingStoreException) {
                complete = false
            }
        }
        if (!complete) return
        owed = null
        // If the marker cannot be taken back it names attempts that are gone (keys are never reused), so the next
        // process finds nothing to remove and tries again.
        try {
            store.clearObligation()
        } catch (e: PendingStoreException) {
            // See above.
        }
    }

    /**
     * The safe exit when the record of what a sign-out owes cannot be read: forget EVERY payment saved on this phone
     * and the record itself, after the person confirmed ("If you already paid, check with the merchant first"). If
     * storage will not let go, nothing changes and the screen says so.
     */
    fun resetCheckoutData() {
        val current = _state.value as? CheckoutState.StorageBlocked ?: return
        if (current.block != StorageBlock.ObligationUnreadable && current.block != StorageBlock.ResetFailed) return
        try {
            for (slot in store.all()) {
                when (slot) {
                    is PendingSlot.Pending -> store.remove(slot.pending.request.code)
                    is PendingSlot.Unreadable -> store.remove(slot.slotId)
                }
            }
            store.clearObligation()
        } catch (e: PendingStoreException) {
            _state.value = current.copy(block = StorageBlock.ResetFailed)
            return
        }
        owed = null
        obligationLoaded = true
        hideSessionAttempts = false
        pendingAdoption = null
        clearForm()
        held = null
        val mine = supersede()
        present(current.code, mine)
    }

    /**
     * The check, or a sign-in, confirmed whose session this is: attempts made before it finished get their owner,
     * except those a sign-out owes the removal of. An attempt that cannot be saved with its new owner is KEPT (never
     * dropped, never swallowed) and adoption is retried the next time a link is shown.
     */
    private fun adoptUnconfirmed(userId: String) {
        pendingAdoption = null
        val slots = try {
            store.all()
        } catch (e: PendingStoreException) {
            pendingAdoption = userId
            return
        }
        for (slot in slots) {
            val pending = (slot as? PendingSlot.Pending)?.pending ?: continue
            if (pending.owner != AttemptOwner.Session(null) || isHidden(pending)) continue
            val adopted = pending.copy(owner = AttemptOwner.Session(userId))
            try {
                store.save(adopted)
            } catch (e: PendingStoreException) {
                pendingAdoption = userId
                continue
            }
            if (held?.key == adopted.key) held = held?.copy(owner = adopted.owner)
        }
    }

    // ---- latest wins -------------------------------------------------------------------------------------------

    /** Starts a new generation and cancels the previous request. Returns the new generation. */
    private fun supersede(): Long {
        job?.cancel()
        job = null
        return ++generation
    }

    private fun isCurrent(mine: Long) = mine == generation
}
