package com.folusayo.kobolink.wallet

import android.content.SharedPreferences
import java.io.IOException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * Where an unresolved payment is remembered (see [SendFlow]): one slot per
 * signed-in user, so one person's pending payment is never shown to, or
 * replayed by, another.
 */
interface PendingAttemptStore {
    fun load(userId: String): TransferAttempt?

    /**
     * Durably record [attempt] for [userId], or clear the slot when null.
     * Throws if it could not be written: [SendFlow] then does not send.
     */
    fun save(userId: String, attempt: TransferAttempt?)
}

/** Process-lifetime only; for tests, and as the shape a fake persistent store takes. */
class InMemoryPendingAttemptStore : PendingAttemptStore {
    private val slots = HashMap<String, TransferAttempt>()
    override fun load(userId: String) = slots[userId]
    override fun save(userId: String, attempt: TransferAttempt?) {
        if (attempt == null) slots.remove(userId) else slots[userId] = attempt
    }
}

/** Used when secure storage could not be opened: nothing can be recorded, so nothing can be sent. */
class UnavailablePendingAttemptStore(private val reason: Throwable?) : PendingAttemptStore {
    override fun load(userId: String): TransferAttempt? = null
    override fun save(userId: String, attempt: TransferAttempt?) {
        if (attempt != null) throw IOException("Secure storage is unavailable, so the payment was not recorded.", reason)
    }
}

/** The on-disk form of an attempt: a small JSON object, never anything secret beyond the payment's own details. */
object PendingAttemptCodec {
    fun encode(attempt: TransferAttempt): String = buildJsonObject {
        put("key", attempt.key)
        put("phone", attempt.toPhone)
        put("amountKobo", attempt.amountKobo)
        put("note", attempt.note)
        put("payee", attempt.payeeName)
    }.toString()

    fun decode(raw: String): TransferAttempt? {
        val obj = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return null
        fun text(name: String) = (obj[name] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull
        return TransferAttempt(
            key = text("key") ?: return null,
            toPhone = text("phone") ?: return null,
            amountKobo = (obj["amountKobo"] as? JsonPrimitive)?.longOrNull ?: return null,
            note = text("note"),
            payeeName = text("payee"),
        )
    }
}

/**
 * The pending payment, on disk, in `EncryptedSharedPreferences` (the same
 * secure-storage family as the M2 session token: AES256-GCM values,
 * AES256-SIV keys, a Keystore-held master key), keyed by user id. It holds
 * the payment's idempotency key, number, amount, optional note and the QR
 * name shown to the person; no token, no password.
 *
 * [prefs] is whatever `EncryptedSharedPreferences.create` returned (see
 * [com.folusayo.kobolink.auth.openEncryptedPrefs]); tests pass a fake. Writes
 * use `commit()`, not `apply()`: the point is that the record is on disk
 * before the request leaves, and a failed write must be seen.
 */
class EncryptedPendingAttemptStore(private val prefs: SharedPreferences) : PendingAttemptStore {

    override fun load(userId: String): TransferAttempt? =
        prefs.getString(slot(userId), null)?.let(PendingAttemptCodec::decode)

    override fun save(userId: String, attempt: TransferAttempt?) {
        val editor = prefs.edit()
        if (attempt == null) editor.remove(slot(userId)) else editor.putString(slot(userId), PendingAttemptCodec.encode(attempt))
        if (!editor.commit()) throw IOException("Secure storage did not accept the pending payment (commit failed).")
    }

    private fun slot(userId: String) = "pending.$userId"

    companion object {
        /** Backing file under `shared_prefs/`; excluded from backup in backup_rules.xml and data_extraction_rules.xml. */
        const val PREFS_FILE_NAME = "kobolink_pending_payments"
    }
}
