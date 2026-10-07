package com.folusayo.kobolink.checkout

import android.content.SharedPreferences
import java.io.IOException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/**
 * A payment attempt whose outcome is not settled: `initialize` was (or is about to be) sent under [key], and the
 * app has not seen a definite refusal. [reference] is set once the server answered with a pending checkout;
 * [confirmedAmountKobo] is the amount it echoed. With no [reference] the outcome is unknown: the request may have
 * been stored by the server, so the only safe retry is the identical [request] under the identical [key].
 *
 * Holds the payer's name and e-mail (they are part of the request the key is bound to), so it only ever lives in
 * secure storage; see [EncryptedPendingCheckoutStore].
 */
data class PendingCheckout(
    val request: InitializeRequest,
    val key: String,
    val reference: String? = null,
    val confirmedAmountKobo: Int? = null,
    /**
     * The signed-in user's id when the attempt was made, or null for a payer with no account (or one made while the
     * session was still resolving). Never used to FIND the slot, only to hide it from, and clear it for, a DIFFERENT
     * confirmed user; see [CheckoutController.bindOwner].
     */
    val owner: String? = null,
)

/**
 * Where an unsettled payment is remembered so that it outlives the screen, the Activity (Back, Done and
 * Close all `finish()` it for a payer, which destroys the ViewModel) and the process. Without it the idempotency
 * key lived only in memory, so re-tapping the link started a fresh controller with a fresh key: a second pending
 * checkout for one payment.
 *
 * One slot per link code on the device, found whatever the session is doing: every new process starts with the
 * session still resolving, so a slot keyed by "who is signed in" is not the one the cold start reads.
 */
interface PendingCheckoutStore {
    /** The slot for [code], or null. Never throws: unreadable storage is "nothing remembered". */
    fun load(code: String): PendingCheckout?

    /**
     * Durably record [pending] for [code]. Throws if it could not be written; the controller then does not send.
     * A null [pending] clears the slot, and throws if it could not.
     */
    fun save(code: String, pending: PendingCheckout?)

    /** Forget every slot made by signed-in user [userId] (their explicit sign-out). Payers' slots stay. */
    fun clearOwnedBy(userId: String)

    /** Forget every slot made by a signed-in user other than [userId] (a different user is confirmed). Payers' slots stay. */
    fun clearOwnedByOthers(userId: String)
}

/** Process-lifetime only: the default for tests, and the shape a fake persistent store takes. */
class InMemoryPendingCheckoutStore : PendingCheckoutStore {
    private val slots = HashMap<String, PendingCheckout>()

    override fun load(code: String) = slots[code]

    override fun save(code: String, pending: PendingCheckout?) {
        if (pending == null) slots.remove(code) else slots[code] = pending
    }

    override fun clearOwnedBy(userId: String) {
        slots.values.removeAll { it.owner == userId }
    }

    override fun clearOwnedByOthers(userId: String) {
        slots.values.removeAll { it.owner != null && it.owner != userId }
    }
}

/** Used when secure storage could not be opened: nothing can be recorded, so no payment can be sent. */
class UnavailablePendingCheckoutStore(private val reason: Throwable? = null) : PendingCheckoutStore {
    override fun load(code: String): PendingCheckout? = null

    override fun save(code: String, pending: PendingCheckout?) {
        if (pending != null) throw IOException("Secure storage is unavailable, so the payment was not recorded.", reason)
    }

    override fun clearOwnedBy(userId: String) = Unit

    override fun clearOwnedByOthers(userId: String) = Unit
}

/** The on-disk form of a pending payment: a small JSON object. */
object PendingCheckoutCodec {
    fun encode(pending: PendingCheckout): String = buildJsonObject {
        put("key", pending.key)
        put("code", pending.request.code)
        put("amountKobo", pending.request.amountKobo)
        put("name", pending.request.payerName)
        put("email", pending.request.payerEmail)
        put("reference", pending.reference)
        put("confirmedAmountKobo", pending.confirmedAmountKobo)
        put("owner", pending.owner)
    }.toString()

    /** Null for anything unreadable: a corrupt slot is "nothing remembered", never a crash. */
    fun decode(raw: String): PendingCheckout? {
        val obj = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return null
        fun text(name: String) = (obj[name] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull
        fun number(name: String) = (obj[name] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.intOrNull
        return PendingCheckout(
            request = InitializeRequest(
                code = text("code") ?: return null,
                amountKobo = number("amountKobo") ?: return null,
                payerName = text("name") ?: return null,
                payerEmail = text("email") ?: return null,
            ),
            key = text("key") ?: return null,
            reference = text("reference"),
            confirmedAmountKobo = number("confirmedAmountKobo"),
            owner = text("owner"),
        )
    }
}

/**
 * The pending payments, on disk, in `EncryptedSharedPreferences` (the same recipe as the M2 session token, opened by
 * [com.folusayo.kobolink.auth.openEncryptedPrefs]: AES256-GCM values, AES256-SIV keys, a Keystore-held master key).
 *
 * [prefs] is whatever `EncryptedSharedPreferences.create` returned; tests pass a fake. Writes use `commit()`, not
 * `apply()`: the point is that the record is on disk before the request leaves, and a failed write must be seen.
 */
class EncryptedPendingCheckoutStore(private val prefs: SharedPreferences) : PendingCheckoutStore {

    override fun load(code: String): PendingCheckout? = try {
        prefs.getString(slot(code), null)?.let(PendingCheckoutCodec::decode)
    } catch (e: Exception) {
        null
    }

    override fun save(code: String, pending: PendingCheckout?) {
        val editor = prefs.edit()
        if (pending == null) editor.remove(slot(code)) else editor.putString(slot(code), PendingCheckoutCodec.encode(pending))
        if (!editor.commit()) throw IOException("Secure storage did not accept the pending payment (commit failed).")
    }

    override fun clearOwnedBy(userId: String) = removeWhere { it.owner == userId }

    override fun clearOwnedByOthers(userId: String) = removeWhere { it.owner != null && it.owner != userId }

    private fun removeWhere(matches: (PendingCheckout) -> Boolean) {
        val editor = prefs.edit()
        for ((name, value) in prefs.all) {
            if (!name.startsWith(SLOT_PREFIX)) continue
            val pending = (value as? String)?.let(PendingCheckoutCodec::decode)
            if (pending != null && matches(pending)) editor.remove(name)
        }
        if (!editor.commit()) throw IOException("Secure storage did not clear the pending payments (commit failed).")
    }

    private fun slot(code: String) = SLOT_PREFIX + code

    companion object {
        /** Backing file under `shared_prefs/`; excluded from backup in backup_rules.xml and data_extraction_rules.xml. */
        const val PREFS_FILE_NAME = "kobolink_pending_checkouts"
        private const val SLOT_PREFIX = "pending/"
    }
}
