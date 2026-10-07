package com.folusayo.kobolink.wallet

import com.folusayo.kobolink.generated.api.models.TransferResponse
import com.folusayo.kobolink.money.Kobo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/** What the person has typed. Strings, because that is what a field holds; [checkSendForm] is where they become numbers. */
data class SendForm(
    val phone: String = "",
    val amount: String = "",
    val note: String = "",
    /** The name a scanned QR code carried, shown so the sender can see who they are paying. Null when typed by hand. */
    val payeeName: String? = null,
)

sealed interface SendFormCheck {
    data class Valid(val toPhone: String, val amountKobo: Long, val note: String?) : SendFormCheck
    data class Invalid(val phone: String?, val amount: String?, val note: String?) : SendFormCheck
}

/** Validates the form the way the server will, so mistakes show up beside the field instead of as a failed request. */
fun checkSendForm(form: SendForm): SendFormCheck {
    val phone = NigerianPhone.normalize(form.phone)
    val phoneError = when {
        form.phone.isBlank() -> "Enter the recipient's phone number."
        !NigerianPhone.isValid(phone) -> "Enter a Nigerian mobile number, like 0803 123 4567."
        else -> null
    }

    val amountKobo = Kobo.parseNaira(form.amount)
    val amountError = when {
        form.amount.isBlank() -> "Enter an amount."
        amountKobo == null -> "Use digits only, like 1,500 or 1,500.50."
        amountKobo < TransferLimits.MIN_AMOUNT_KOBO ->
            "The smallest transfer is ${Kobo.formatNaira(TransferLimits.MIN_AMOUNT_KOBO)}."
        amountKobo > TransferLimits.MAX_AMOUNT_KOBO ->
            "The largest transfer is ${Kobo.formatNaira(TransferLimits.MAX_AMOUNT_KOBO)}."
        else -> null
    }

    val note = form.note.trim()
    val noteError = if (note.length > TransferLimits.NOTE_MAX_LENGTH) {
        "Keep the note under ${TransferLimits.NOTE_MAX_LENGTH} characters."
    } else {
        null
    }

    if (phoneError != null || amountError != null || noteError != null || amountKobo == null) {
        return SendFormCheck.Invalid(phoneError, amountError, noteError)
    }
    return SendFormCheck.Valid(toPhone = phone, amountKobo = amountKobo, note = note.ifEmpty { null })
}

/**
 * One logical payment. [key] is its `Idempotency-Key`: created when the form
 * is accepted, reused if (and only if) the same request is replayed after an
 * unknown outcome, never shared between two payments.
 */
data class TransferAttempt(
    val key: String,
    val toPhone: String,
    val amountKobo: Long,
    val note: String?,
    val payeeName: String?,
)

sealed interface SendPhase {
    data object Editing : SendPhase
    data class Confirming(val attempt: TransferAttempt) : SendPhase
    data class Sending(val attempt: TransferAttempt) : SendPhase
    data class Sent(val attempt: TransferAttempt, val response: TransferResponse) : SendPhase
    data class Failed(val attempt: TransferAttempt, val failure: TransferFailure) : SendPhase
}

data class SendState(
    val form: SendForm = SendForm(),
    /** Field errors stay quiet until the person first tries to send, then track the fields live. */
    val showErrors: Boolean = false,
    val phase: SendPhase = SendPhase.Editing,
)

/**
 * The send-money state machine, free of Android types so every transition is
 * a JVM test: Editing -> Confirming -> Sending -> Sent | Failed.
 *
 * What it guarantees:
 * - **One tap, one request.** A request only starts from [SendPhase.Confirming],
 *   and starting it moves to [SendPhase.Sending] in the same step, so a second
 *   tap on the confirm button finds nothing to do.
 * - **One key per payment.** [newKey] is called each time the form is accepted for confirmation. The
 *   only path that reuses a key is [tryAgain], which replays the identical
 *   [TransferAttempt] after a failure whose outcome is not known to be "no".
 * - **No double payment by editing, leaving, or dying.** Until an attempt is
 *   settled (a success, or a failure where no money moved) it is [pending]:
 *   remembered in [store] (which the ViewModel backs with saved state, so it
 *   survives process death), kept by [start] instead of being overwritten,
 *   and offered back as the thing to resolve. The person either replays it
 *   under its own key ([tryAgain]) or says they checked and it did not go
 *   through ([discardUnresolved]). There is no path that quietly forgets it
 *   and lets a second, differently-keyed payment go out.
 * - **No stale write.** A reply that arrives after [reset] (sign-out) is
 *   dropped, so one person's payment never reaches the next person's screen.
 */
class SendFlow(
    private val gateway: WalletGateway,
    private val scope: CoroutineScope,
    private val newKey: () -> String,
    private val store: PendingAttemptStore = InMemoryPendingAttemptStore(),
    private val onSent: (TransferResponse) -> Unit = {},
    private val onFailed: (TransferFailure) -> Unit = {},
) {
    private val _state = MutableStateFlow(SendState())
    val state: StateFlow<SendState> = _state

    private val _pending = MutableStateFlow<TransferAttempt?>(null)

    /** The attempt whose outcome is not settled, if any: in flight, or failed with the money possibly moved. */
    val pending: StateFlow<TransferAttempt?> = _pending

    // Bumped by reset() so a reply to a request from before it cannot land after.
    private var generation = 0

    init {
        // A new process: the previous one died with a payment unresolved. We
        // never saw how it ended, so say exactly that and offer the safe replay.
        store.load()?.let { attempt ->
            _pending.value = attempt
            _state.value = SendState(
                form = SendForm(phone = attempt.toPhone, amount = nairaFieldText(attempt.amountKobo), note = attempt.note.orEmpty(), payeeName = attempt.payeeName),
                phase = SendPhase.Failed(attempt, TransferFailure(TransferFailureKind.Interrupted, MoneyMoved.Unknown)),
            )
        }
    }

    /**
     * Begin a fresh payment, optionally pre-filled from a scanned QR code.
     * Returns false, changing nothing, while an earlier payment is unresolved:
     * the screen then shows that one, and the person settles it first.
     */
    fun start(form: SendForm = SendForm()): Boolean {
        if (_pending.value != null) return false
        _state.value = SendState(form = form)
        return true
    }

    /** Sign-out or session end: forget everything, including an unresolved payment, and ignore any reply still on its way. */
    fun reset() {
        generation += 1
        store.save(null)
        _pending.value = null
        _state.value = SendState()
    }

    /**
     * "I checked, and it did not go through." The only way to drop an
     * unresolved attempt, and it is the person's explicit statement: the
     * screen asks them to look at Recent activity first.
     */
    fun discardUnresolved() {
        val phase = _state.value.phase
        if (phase is SendPhase.Failed && phase.failure.retryWithSameRequest) {
            settle()
            _state.value = SendState()
        }
    }

    fun edit(form: SendForm) {
        val current = _state.value
        if (current.phase != SendPhase.Editing) return
        _state.value = current.copy(form = form)
    }

    /** "Send" on the form: validate, then ask for confirmation. */
    fun submit() {
        val current = _state.value
        if (current.phase != SendPhase.Editing) return
        when (val check = checkSendForm(current.form)) {
            is SendFormCheck.Invalid -> _state.value = current.copy(showErrors = true)
            is SendFormCheck.Valid -> _state.value = current.copy(
                showErrors = true,
                phase = SendPhase.Confirming(
                    TransferAttempt(
                        key = newKey(),
                        toPhone = check.toPhone,
                        amountKobo = check.amountKobo,
                        note = check.note,
                        payeeName = current.form.payeeName,
                    ),
                ),
            )
        }
    }

    fun cancelConfirmation() {
        val current = _state.value
        if (current.phase is SendPhase.Confirming) _state.value = current.copy(phase = SendPhase.Editing)
    }

    /** "Send" in the confirmation dialog. */
    fun confirm() {
        val phase = _state.value.phase
        if (phase is SendPhase.Confirming) send(phase.attempt)
    }

    /**
     * "Try again". After an unknown outcome this replays the IDENTICAL request
     * under the IDENTICAL key, so the server returns the original result if it
     * did post and posts exactly once if it did not. After a definite "no
     * money moved" with nothing wrong in the details (offline, rate limit) it
     * is a fresh payment under a fresh key, since the old key never reached a
     * decision worth replaying.
     */
    fun tryAgain() {
        val phase = _state.value.phase
        if (phase !is SendPhase.Failed) return
        val failure = phase.failure
        when {
            failure.retryWithSameRequest -> send(phase.attempt)
            failure.canEditAndResend && failure.worthTryingAgain -> send(phase.attempt.copy(key = newKey()))
        }
    }

    /** Back to the form with what was typed, after a failure where nothing was taken. */
    fun editAgain() {
        val current = _state.value
        val phase = current.phase
        if (phase is SendPhase.Failed && phase.failure.canEditAndResend) {
            _state.value = current.copy(phase = SendPhase.Editing)
        }
    }

    private fun send(attempt: TransferAttempt) {
        // Remember it BEFORE the request leaves: if the process dies mid-flight
        // the next one knows there is a payment to resolve, and under which key.
        store.save(attempt)
        _pending.value = attempt
        _state.value = _state.value.copy(phase = SendPhase.Sending(attempt))
        val started = generation
        scope.launch {
            val result = try {
                gateway.transfer(attempt.key, attempt.toPhone, attempt.amountKobo, attempt.note)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Whatever it was, a request may have gone out: unknown, and replayable.
                TransferResult.Failed(unexpectedFailure())
            }
            if (generation != started) return@launch
            when (result) {
                is TransferResult.Sent -> {
                    settle()
                    _state.value = _state.value.copy(phase = SendPhase.Sent(attempt, result.response))
                    onSent(result.response)
                }
                is TransferResult.Failed -> {
                    // Only a definite "no money moved" settles it; anything else stays pending.
                    if (result.failure.canEditAndResend) settle()
                    _state.value = _state.value.copy(phase = SendPhase.Failed(attempt, result.failure))
                    onFailed(result.failure)
                }
            }
        }
    }

    private fun settle() {
        store.save(null)
        _pending.value = null
    }
}
