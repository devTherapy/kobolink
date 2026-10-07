package com.folusayo.kobolink.wallet

import androidx.lifecycle.SavedStateHandle

/**
 * Where the one unresolved payment is remembered (see [SendFlow]). At most
 * one: a second payment cannot start while this holds one.
 */
interface PendingAttemptStore {
    fun load(): TransferAttempt?
    fun save(attempt: TransferAttempt?)
}

class InMemoryPendingAttemptStore : PendingAttemptStore {
    private var value: TransferAttempt? = null
    override fun load() = value
    override fun save(attempt: TransferAttempt?) {
        value = attempt
    }
}

/**
 * Backed by the ViewModel's [SavedStateHandle], which the system persists
 * across process death. That is what lets a payment whose outcome was never
 * seen be replayed under its ORIGINAL idempotency key after the app is
 * killed and reopened, instead of the person paying again under a new one.
 *
 * Holds the payment's key, number, amount, optional note and the QR name
 * shown to the person. It is not a credential and not a token (tokens stay
 * in the M2 encrypted store); it is a short-lived "is there a payment to
 * resolve" marker, cleared as soon as the payment settles or on sign-out.
 */
class SavedStatePendingAttemptStore(private val handle: SavedStateHandle) : PendingAttemptStore {

    override fun load(): TransferAttempt? {
        val key = handle.get<String>(KEY) ?: return null
        val phone = handle.get<String>(PHONE) ?: return null
        val amount = handle.get<Long>(AMOUNT) ?: return null
        return TransferAttempt(
            key = key,
            toPhone = phone,
            amountKobo = amount,
            note = handle.get<String>(NOTE),
            payeeName = handle.get<String>(PAYEE),
        )
    }

    override fun save(attempt: TransferAttempt?) {
        if (attempt == null) {
            listOf(KEY, PHONE, AMOUNT, NOTE, PAYEE).forEach { handle.remove<Any>(it) }
            return
        }
        handle[KEY] = attempt.key
        handle[PHONE] = attempt.toPhone
        handle[AMOUNT] = attempt.amountKobo
        handle[NOTE] = attempt.note
        handle[PAYEE] = attempt.payeeName
    }

    private companion object {
        const val KEY = "pending.key"
        const val PHONE = "pending.phone"
        const val AMOUNT = "pending.amountKobo"
        const val NOTE = "pending.note"
        const val PAYEE = "pending.payee"
    }
}
