package com.folusayo.kobolink.checkout

import android.content.SharedPreferences
import java.io.IOException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/**
 * Who made a payment attempt, recorded only so that the right sign-out can forget it. The same rule as iOS's
 * `AttemptOwner` (feature I3), and [CheckoutController] is the only code that applies it:
 *
 * - [Payer]: made while nobody was signed in on this device (no stored session). A payer's attempt is never cleared
 *   by a merchant signing out or changing; only a definite server refusal or a confirmed "Start a new payment"
 *   removes it.
 * - [Session]: made while a session existed on the device, whether it was signed in, still resolving, or offline.
 *   [Session.userId] is null until the server has confirmed who the session belongs to, and is filled in then
 *   (the cold-start `/me` check confirming the token that was already stored), so an attempt made in the seconds
 *   before the check finishes is never ownerless.
 *
 * What each session event does with [Session] attempts:
 *
 * - explicit sign-out: removes every one of them, whoever made it (sign-out ends the merchant context on this
 *   device). It is gated: [CheckoutController.prepareSignOut] writes what it owes ([SignOutObligation]) BEFORE the
 *   sign-out, and if that cannot be written the sign-out does not happen;
 * - the check confirms user U: attempts with no user id become U's; attempts made by another confirmed user are
 *   removed;
 * - a sign-in with credentials as U: attempts with no user id are adopted by U exactly as above, and only those
 *   made by another CONFIRMED user are removed. A sign-in NEVER drops an unconfirmed attempt: it may be the same
 *   person's, with an outcome nobody has seen (their token expired while the first request was in the air), and
 *   forgetting it would let the form mint a second key. An adoption that cannot be saved keeps the attempt and is
 *   retried;
 * - involuntary expiry (a 401): removes nothing.
 */
sealed interface AttemptOwner {
    data object Payer : AttemptOwner

    data class Session(val userId: String?) : AttemptOwner
}

val AttemptOwner.isSession: Boolean get() = this is AttemptOwner.Session

/**
 * A payment attempt whose outcome is not settled: `initialize` was (or is about to be) sent under [key], and the
 * app has not seen a definite refusal. [reference] is set once the server answered with a pending checkout;
 * [confirmedAmountKobo] is the amount it echoed. With no [reference] the outcome is unknown: the request may have
 * been stored by the server, so the only safe retry is the identical [request] under the identical [key].
 *
 * Holds the payer's name and e-mail (they are part of the request the key is bound to), so it only ever lives in
 * secure storage, and **no screen ever shows them** (see `CheckoutPrivacyTest`): they are only sent again, in a
 * same-key retry.
 */
data class PendingCheckout(
    val request: InitializeRequest,
    val key: String,
    val reference: String? = null,
    val confirmedAmountKobo: Int? = null,
    val owner: AttemptOwner = AttemptOwner.Payer,
)

/** What a store operation was doing when it failed. */
enum class StoreOperation { Read, Write, Remove, List, Obligation }

enum class StoreFailureKind {
    /** The store refused or could not be reached (a Keystore that will not open). The slot may still be there. */
    Unavailable,

    /** Something is stored that this build cannot read. It is neither "nothing" nor usable. */
    Undecodable,
}

/**
 * Why a pending-payment slot could not be read, written or removed. Never carries any part of the record. An
 * [IOException], so a caller that only cares that it failed can catch that.
 */
class PendingStoreException(
    val operation: StoreOperation,
    val kind: StoreFailureKind = StoreFailureKind.Unavailable,
    cause: Throwable? = null,
) : IOException("Pending-payment storage failed: $operation, $kind", cause)

/**
 * The attempts a sign-out owes the device, written down BEFORE the sign-out happens and taken back when they are
 * gone. Without it a clear that failed (storage that will not write) is forgotten by a restart, and the next
 * process shows the signed-out person's attempt to whoever holds the phone.
 *
 * It names attempts by their identity (link code and idempotency key), not by a time: an attempt made later has a
 * key of its own and can never be swept up by a leftover obligation, whatever the clock says. Only a sign-out owes
 * anything: the removal of ANOTHER user's attempts is derived again from the session at every launch, so it needs
 * no record.
 */
data class SignOutObligation(val entries: List<Entry>) {
    /** [code] is the slot id, which is the link code. [key] is null for a slot that could not be read (it has no key to name). */
    data class Entry(val code: String, val key: String?)

    fun contains(code: String, key: String?): Boolean = entries.contains(Entry(code, key))
}

/** One entry of [PendingCheckoutStore.all]. */
sealed interface PendingSlot {
    data class Pending(val pending: PendingCheckout) : PendingSlot

    /** A slot that exists but cannot be decoded; [slotId] is what [PendingCheckoutStore.remove] takes. */
    data class Unreadable(val slotId: String) : PendingSlot
}

/**
 * Where an unsettled payment is remembered so that it outlives the screen, the Activity (Back, Done and Close all
 * `finish()` it for a payer, which destroys the ViewModel) and the process. Without it the idempotency key lived
 * only in memory, so re-tapping the link started a fresh controller with a fresh key: a second pending checkout for
 * one payment.
 *
 * One slot per link code on the device, found whatever the session is doing: every new process starts with the
 * session still resolving, so a slot keyed by "who is signed in" is not the one the cold start reads.
 *
 * Every call is synchronous and durable. `save` returning means the record is in secure storage, which is what lets
 * [CheckoutController] write it BEFORE the request leaves: if it cannot be written, nothing is sent. There is no
 * fallback to any other storage. Every failure is a [PendingStoreException]; none is ever read as "nothing".
 */
interface PendingCheckoutStore {
    /** The slot for [code], or null if nothing is stored. A throw is "could not find out" or "something is there I cannot read". */
    fun load(code: String): PendingCheckout?

    /** Durably record the attempt in the slot of its link code, replacing what was there. */
    fun save(pending: PendingCheckout)

    /** Forget the slot with id [code] (also an unreadable one); removing a slot that is not there is not an error. */
    fun remove(code: String)

    /** Every slot on the device. */
    fun all(): List<PendingSlot>

    /** The cleanup still owed, or null. A throw is "could not find out", never "nothing owed". */
    fun loadObligation(): SignOutObligation?

    fun saveObligation(obligation: SignOutObligation)

    fun clearObligation()
}

/**
 * A store in memory, for tests and previews. It does not persist anything, so it must never be what a shipping build
 * uses. Each failure can be switched on with [fail] and off with [heal].
 */
class InMemoryPendingCheckoutStore : PendingCheckoutStore {
    private val slots = LinkedHashMap<String, PendingSlot>()
    private val failures = HashMap<StoreOperation, StoreFailureKind>()
    private var storedObligation: SignOutObligation? = null

    /** Make every later [operation] throw, until [heal]. */
    fun fail(operation: StoreOperation, kind: StoreFailureKind = StoreFailureKind.Unavailable) {
        failures[operation] = kind
    }

    fun heal() = failures.clear()

    /** Put something unreadable in a slot, as a downgraded or corrupted item would be. */
    fun plantUnreadable(code: String) {
        slots[code] = PendingSlot.Unreadable(code)
    }

    private fun check(operation: StoreOperation) {
        failures[operation]?.let { throw PendingStoreException(operation, it) }
    }

    override fun load(code: String): PendingCheckout? {
        check(StoreOperation.Read)
        return when (val slot = slots[code]) {
            is PendingSlot.Pending -> slot.pending
            is PendingSlot.Unreadable -> throw PendingStoreException(StoreOperation.Read, StoreFailureKind.Undecodable)
            null -> null
        }
    }

    override fun save(pending: PendingCheckout) {
        check(StoreOperation.Write)
        slots[pending.request.code] = PendingSlot.Pending(pending)
    }

    override fun remove(code: String) {
        check(StoreOperation.Remove)
        slots.remove(code)
    }

    override fun all(): List<PendingSlot> {
        check(StoreOperation.List)
        return slots.keys.sorted().mapNotNull { slots[it] }
    }

    override fun loadObligation(): SignOutObligation? {
        check(StoreOperation.Obligation)
        return storedObligation
    }

    override fun saveObligation(obligation: SignOutObligation) {
        check(StoreOperation.Obligation)
        storedObligation = obligation
    }

    override fun clearObligation() {
        check(StoreOperation.Obligation)
        storedObligation = null
    }

    /** The obligation as stored, without going through the failure switches, for assertions. */
    val obligation: SignOutObligation? get() = storedObligation

    /** Everything stored and readable, without going through the failure switches, for assertions. */
    val snapshot: List<PendingCheckout>
        get() = slots.keys.sorted().mapNotNull { (slots[it] as? PendingSlot.Pending)?.pending }
}

/**
 * Used when secure storage could not be opened at all. It holds nothing it can show and accepts nothing, and says so
 * with an [StoreFailureKind.Unavailable] failure on every call: the checkout then refuses to open a link (it cannot
 * tell whether a payment is already under way) rather than treat an unopenable store as an empty one.
 */
class UnavailablePendingCheckoutStore(private val reason: Throwable? = null) : PendingCheckoutStore {
    private fun fail(operation: StoreOperation): Nothing = throw PendingStoreException(operation, StoreFailureKind.Unavailable, reason)

    override fun load(code: String): PendingCheckout? = fail(StoreOperation.Read)

    override fun save(pending: PendingCheckout) = fail(StoreOperation.Write)

    override fun remove(code: String) = fail(StoreOperation.Remove)

    override fun all(): List<PendingSlot> = fail(StoreOperation.List)

    override fun loadObligation(): SignOutObligation? = fail(StoreOperation.Obligation)

    override fun saveObligation(obligation: SignOutObligation) = fail(StoreOperation.Obligation)

    override fun clearObligation() = fail(StoreOperation.Obligation)
}

/**
 * Opens the real store lazily and keeps it only once it has opened. A failure to open (a Keystore that is not ready
 * yet, a locked device) is NOT remembered for the life of the process: every call tries again, so a transient fault
 * does not make sign-out, and every link, fail until the app is restarted. While it cannot be opened it behaves as
 * [UnavailablePendingCheckoutStore].
 */
class ReopeningPendingCheckoutStore(private val open: () -> PendingCheckoutStore) : PendingCheckoutStore {
    private var opened: PendingCheckoutStore? = null

    @Synchronized
    private fun store(): PendingCheckoutStore {
        opened?.let { return it }
        return try {
            open().also { opened = it }
        } catch (e: Exception) {
            UnavailablePendingCheckoutStore(e)
        }
    }

    override fun load(code: String) = store().load(code)

    override fun save(pending: PendingCheckout) = store().save(pending)

    override fun remove(code: String) = store().remove(code)

    override fun all() = store().all()

    override fun loadObligation() = store().loadObligation()

    override fun saveObligation(obligation: SignOutObligation) = store().saveObligation(obligation)

    override fun clearObligation() = store().clearObligation()
}

/** The on-disk form of a pending payment: a small versioned JSON object. */
object PendingCheckoutCodec {
    const val FORMAT_VERSION = 1

    fun encode(pending: PendingCheckout): String = buildJsonObject {
        put("version", FORMAT_VERSION)
        put("key", pending.key)
        put("code", pending.request.code)
        put("amountKobo", pending.request.amountKobo)
        put("name", pending.request.payerName)
        put("email", pending.request.payerEmail)
        put("reference", pending.reference)
        put("confirmedAmountKobo", pending.confirmedAmountKobo)
        when (val owner = pending.owner) {
            AttemptOwner.Payer -> put("ownerKind", "payer")
            is AttemptOwner.Session -> {
                put("ownerKind", "session")
                put("ownerUserId", owner.userId)
            }
        }
    }.toString()

    /** Null for anything this build cannot read: a corrupt or unknown-version slot is "unreadable", never a crash and never "nothing". */
    fun decode(raw: String): PendingCheckout? {
        val obj = parseObject(raw) ?: return null
        if (number(obj, "version") != FORMAT_VERSION) return null
        val key = text(obj, "key")?.takeIf { it.isNotBlank() } ?: return null
        val owner = when (text(obj, "ownerKind")) {
            "payer" -> AttemptOwner.Payer
            "session" -> AttemptOwner.Session(text(obj, "ownerUserId"))
            else -> return null
        }
        return PendingCheckout(
            request = InitializeRequest(
                code = text(obj, "code") ?: return null,
                amountKobo = number(obj, "amountKobo") ?: return null,
                payerName = text(obj, "name") ?: return null,
                payerEmail = text(obj, "email") ?: return null,
            ),
            key = key,
            reference = text(obj, "reference"),
            confirmedAmountKobo = number(obj, "confirmedAmountKobo"),
            owner = owner,
        )
    }

    fun encodeObligation(obligation: SignOutObligation): String = buildJsonObject {
        put("version", FORMAT_VERSION)
        put(
            "entries",
            buildJsonArray {
                for (entry in obligation.entries) {
                    add(
                        buildJsonObject {
                            put("code", entry.code)
                            put("key", entry.key)
                        },
                    )
                }
            },
        )
    }.toString()

    fun decodeObligation(raw: String): SignOutObligation? {
        val obj = parseObject(raw) ?: return null
        if (number(obj, "version") != FORMAT_VERSION) return null
        val array = obj["entries"] as? JsonArray ?: return null
        val entries = array.map { element ->
            val entry = element as? JsonObject ?: return null
            SignOutObligation.Entry(code = text(entry, "code") ?: return null, key = text(entry, "key"))
        }
        return SignOutObligation(entries)
    }

    private fun parseObject(raw: String): JsonObject? = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull()

    private fun text(obj: JsonObject, name: String) = (obj[name] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull

    private fun number(obj: JsonObject, name: String) = (obj[name] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.intOrNull
}

/**
 * The pending payments, on disk, in `EncryptedSharedPreferences` (the same recipe as the M2 session token, opened by
 * [com.folusayo.kobolink.auth.openEncryptedPrefs]: AES256-GCM values, AES256-SIV keys, a Keystore-held master key).
 *
 * [prefs] is whatever `EncryptedSharedPreferences.create` returned; tests pass a fake. Writes use `commit()`, not
 * `apply()`: the point is that the record is on disk before the request leaves, and a failed write must be seen.
 */
class EncryptedPendingCheckoutStore(private val prefs: SharedPreferences) : PendingCheckoutStore {

    override fun load(code: String): PendingCheckout? {
        val raw = try {
            prefs.getString(slot(code), null)
        } catch (e: Exception) {
            throw PendingStoreException(StoreOperation.Read, StoreFailureKind.Unavailable, e)
        } ?: return null
        return PendingCheckoutCodec.decode(raw) ?: throw PendingStoreException(StoreOperation.Read, StoreFailureKind.Undecodable)
    }

    override fun save(pending: PendingCheckout) {
        write(StoreOperation.Write) { putString(slot(pending.request.code), PendingCheckoutCodec.encode(pending)) }
    }

    override fun remove(code: String) {
        write(StoreOperation.Remove) { remove(slot(code)) }
    }

    override fun all(): List<PendingSlot> {
        val everything = try {
            prefs.all.toMap()
        } catch (e: Exception) {
            throw PendingStoreException(StoreOperation.List, StoreFailureKind.Unavailable, e)
        }
        return everything.keys.filter { it.startsWith(SLOT_PREFIX) }.sorted().map { name ->
            val pending = (everything[name] as? String)?.let(PendingCheckoutCodec::decode)
            if (pending != null) PendingSlot.Pending(pending) else PendingSlot.Unreadable(name.removePrefix(SLOT_PREFIX))
        }
    }

    override fun loadObligation(): SignOutObligation? {
        val raw = try {
            prefs.getString(OBLIGATION_KEY, null)
        } catch (e: Exception) {
            throw PendingStoreException(StoreOperation.Obligation, StoreFailureKind.Unavailable, e)
        } ?: return null
        return PendingCheckoutCodec.decodeObligation(raw)
            ?: throw PendingStoreException(StoreOperation.Obligation, StoreFailureKind.Undecodable)
    }

    override fun saveObligation(obligation: SignOutObligation) {
        write(StoreOperation.Obligation) { putString(OBLIGATION_KEY, PendingCheckoutCodec.encodeObligation(obligation)) }
    }

    override fun clearObligation() {
        write(StoreOperation.Obligation) { remove(OBLIGATION_KEY) }
    }

    private fun write(operation: StoreOperation, edit: SharedPreferences.Editor.() -> Unit) {
        val committed = try {
            val editor = prefs.edit()
            editor.edit()
            editor.commit()
        } catch (e: Exception) {
            throw PendingStoreException(operation, StoreFailureKind.Unavailable, e)
        }
        if (!committed) throw PendingStoreException(operation, StoreFailureKind.Unavailable)
    }

    private fun slot(code: String) = SLOT_PREFIX + code

    companion object {
        /** Backing file under `shared_prefs/`; excluded from backup in backup_rules.xml and data_extraction_rules.xml. */
        const val PREFS_FILE_NAME = "kobolink_pending_checkouts"
        private const val SLOT_PREFIX = "pending/"
        private const val OBLIGATION_KEY = "signout-obligation"
    }
}
