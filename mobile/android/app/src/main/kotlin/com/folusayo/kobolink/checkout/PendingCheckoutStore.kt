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
)

/**
 * Who a pending payment belongs to: the signed-in user's id, or [PAYER_OWNER] for a payer with no account. One
 * slot per owner and link code, so a merchant's session never sees (or replays) a payer's attempt and the reverse.
 */
const val PAYER_OWNER = "payer"

fun ownerFor(userId: String?): String = if (userId == null) PAYER_OWNER else "user:$userId"

/**
 * Where an unsettled payment is remembered so that it outlives the screen, the Activity (Back, Done and
 * Close all `finish()` it for a payer, which destroys the ViewModel) and the process. Without it the idempotency
 * key lived only in memory, so re-tapping the link started a fresh controller with a fresh key: a second pending
 * checkout for one payment.
 */
interface PendingCheckoutStore {
    /** The slot for [code] under [owner], or null. Never throws: unreadable storage is "nothing remembered". */
    fun load(owner: String, code: String): PendingCheckout?

    /**
     * Durably record [pending] for [owner] and [code]. Throws if it could not be written; the controller then does
     * not send. A null [pending] clears the slot.
     */
    fun save(owner: String, code: String, pending: PendingCheckout?)

    /** Forget every slot [owner] holds (sign-out, expiry, a different user). */
    fun clearOwner(owner: String)
}

/** Process-lifetime only: the default for tests, and the shape a fake persistent store takes. */
class InMemoryPendingCheckoutStore : PendingCheckoutStore {
    private val slots = HashMap<Pair<String, String>, PendingCheckout>()

    override fun load(owner: String, code: String) = slots[owner to code]

    override fun save(owner: String, code: String, pending: PendingCheckout?) {
        if (pending == null) slots.remove(owner to code) else slots[owner to code] = pending
    }

    override fun clearOwner(owner: String) {
        slots.keys.removeAll { it.first == owner }
    }
}

/** Used when secure storage could not be opened: nothing can be recorded, so no payment can be sent. */
class UnavailablePendingCheckoutStore(private val reason: Throwable? = null) : PendingCheckoutStore {
    override fun load(owner: String, code: String): PendingCheckout? = null

    override fun save(owner: String, code: String, pending: PendingCheckout?) {
        if (pending != null) throw IOException("Secure storage is unavailable, so the payment was not recorded.", reason)
    }

    override fun clearOwner(owner: String) = Unit
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

    override fun load(owner: String, code: String): PendingCheckout? = try {
        prefs.getString(slot(owner, code), null)?.let(PendingCheckoutCodec::decode)
    } catch (e: Exception) {
        null
    }

    override fun save(owner: String, code: String, pending: PendingCheckout?) {
        val editor = prefs.edit()
        if (pending == null) editor.remove(slot(owner, code)) else editor.putString(slot(owner, code), PendingCheckoutCodec.encode(pending))
        if (!editor.commit()) throw IOException("Secure storage did not accept the pending payment (commit failed).")
    }

    override fun clearOwner(owner: String) {
        val editor = prefs.edit()
        for (name in prefs.all.keys) if (name.startsWith(ownerPrefix(owner))) editor.remove(name)
        if (!editor.commit()) throw IOException("Secure storage did not clear the pending payments (commit failed).")
    }

    private fun ownerPrefix(owner: String) = "pending/$owner/"

    private fun slot(owner: String, code: String) = ownerPrefix(owner) + code

    companion object {
        /** Backing file under `shared_prefs/`; excluded from backup in backup_rules.xml and data_extraction_rules.xml. */
        const val PREFS_FILE_NAME = "kobolink_pending_checkouts"
    }
}
