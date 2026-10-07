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
    /** [replayed]: the reply is the stored ORIGINAL of an earlier attempt, so its balance may be old. */
    data class Sent(val attempt: TransferAttempt, val response: TransferResponse, val replayed: Boolean = false) : SendPhase
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
 * - **One key per payment, reused on every retry of it.** [newKey] is called
 *   each time the form is accepted for confirmation. [tryAgain] replays the
 *   identical [TransferAttempt] under its own key after ANY failure that is
 *   not a server's definite refusal, transport errors included: the server
 *   then returns the original result or, if it never saw the request, posts
 *   once. A new key is only ever used for a changed payment, or after the
 *   server answered with a parsed refusal.
 * - **Nothing is sent that was not first written to disk.** Before a request
 *   leaves, the attempt is saved to the user-scoped [store] (encrypted, on
 *   disk). If that save fails the request is NOT sent. Until the payment
 *   settles (a success, or a server's definite refusal) it stays [pending]:
 *   it survives leaving the screen, a killed process, a reboot and a
 *   sign-out, and comes back for the same user. A different user never sees
 *   it. The only ways out are [tryAgain] or [discardUnresolved], the
 *   person's explicit "I checked, it did not go through".
 * - **No double payment by editing.** After an unknown outcome [editAgain]
 *   does nothing.
 * - **No stale write.** A reply that arrives after the user changed ([bind])
 *   is dropped, so one person's payment never reaches the next person's screen.
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

    private var userId: String? = null

    // Bumped whenever the user changes so a reply to a request from before cannot land after.
    private var generation = 0

    /**
     * Tie the flow to the signed-in user (or to nobody, on sign-out). Their
     * unresolved payment, if the disk holds one, comes back as "we never saw
     * how it ended"; in-memory state of any previous user is dropped, but
     * nothing is deleted from disk.
     */
    fun bind(newUserId: String?) {
        if (newUserId == userId) return
        generation += 1
        userId = newUserId
        _pending.value = null
        _state.value = SendState()
        val attempt = newUserId?.let { runCatching { store.load(it) }.getOrNull() } ?: return
        _pending.value = attempt
        _state.value = SendState(
            form = SendForm(
                phone = attempt.toPhone,
                amount = nairaFieldText(attempt.amountKobo),
                note = attempt.note.orEmpty(),
                payeeName = attempt.payeeName,
            ),
            phase = SendPhase.Failed(attempt, TransferFailure(TransferFailureKind.Interrupted, MoneyMoved.Unknown)),
        )
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
        if (phase is SendPhase.Confirming) send(phase.attempt, replay = false)
    }

    /**
     * "Try again". Unless the server definitively refused the request, this
     * replays the IDENTICAL request under the IDENTICAL key, whatever went
     * wrong (a dropped connection, a 5xx, an app restart): the server returns
     * the original result if it did post and posts exactly once if it did not.
     * Only after a parsed server refusal that is not about the details
     * (a rate limit) is it a fresh payment under a fresh key.
     */
    fun tryAgain() {
        val phase = _state.value.phase
        if (phase !is SendPhase.Failed) return
        val failure = phase.failure
        when {
            failure.retryWithSameRequest -> send(phase.attempt, replay = true)
            failure.canEditAndResend && failure.worthTryingAgain -> send(phase.attempt.copy(key = newKey()), replay = false)
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

    private fun send(attempt: TransferAttempt, replay: Boolean) {
        val user = userId
        // Write it down BEFORE the request leaves: if the process dies mid-flight the next
        // one knows there is a payment to resolve, and under which key. If it cannot be
        // written, nothing is sent: an unrecorded payment could be paid twice.
        val recorded = user != null && runCatching { store.save(user, attempt) }.isSuccess
        if (!recorded) {
            _state.value = _state.value.copy(
                phase = SendPhase.Failed(attempt, TransferFailure(TransferFailureKind.SecureStorageFailed, MoneyMoved.No)),
            )
            return
        }
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
                    _state.value = _state.value.copy(phase = SendPhase.Sent(attempt, result.response, replayed = replay))
                    onSent(result.response)
                }
                is TransferResult.Failed -> {
                    // Only a server's definite refusal settles it; anything else stays pending.
                    if (result.failure.canEditAndResend) settle()
                    _state.value = _state.value.copy(phase = SendPhase.Failed(attempt, result.failure))
                    onFailed(result.failure)
                }
            }
        }
    }

    private fun settle() {
        _pending.value = null
        val user = userId ?: return
        // A marker that fails to clear is harmless: it comes back as "may not have finished",
        // and replaying it returns the original success.
        runCatching { store.save(user, null) }
    }
}
