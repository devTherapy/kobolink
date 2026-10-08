package com.folusayo.kobolink.checkout

import com.folusayo.kobolink.money.Kobo
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Everything the checkout says when it cannot let the payer pay, in one place and free of Android types
 * so a test can pin it. The non-payable deck mirrors `NON_PAYABLE_COPY` in `apps/web/src/lib/checkout.ts`:
 * the web page and the app must not say it two different ways.
 *
 * Every failure states what went wrong, says whether money moved, and offers the next step
 * (docs/DESIGN-SPEC.md, "Failure states name what went wrong, say whether money moved, and offer
 * the next step"). The money line is [NO_MONEY_MOVED], never implied.
 */
const val NO_MONEY_MOVED = "No money has moved."

/** A full-screen notice: a heading, the specifics, whether money moved, and what to do next. */
data class Notice(
    val heading: String,
    val body: String?,
    val moneyLine: String,
    val nextStep: String,
)

/**
 * One notice for every way a link can refuse a payment, [LinkAvailability.Payable] excluded.
 * [LinkAvailability.Unknown] is a `link_not_payable` that did not say which: neutral copy that states only
 * what is known rather than inventing a merchant action nobody confirmed.
 */
fun nonPayableNotice(availability: LinkAvailability, link: CheckoutLink): Notice {
    val merchant = link.merchantName
    return when (availability) {
        LinkAvailability.Disabled -> Notice(
            heading = "This link is turned off",
            body = "$merchant has switched this payment link off.",
            moneyLine = NO_MONEY_MOVED,
            nextStep = "Ask $merchant for a new link, or check back later.",
        )
        LinkAvailability.Expired -> Notice(
            heading = "This link has expired",
            body = link.expiresAt?.let { "This payment link expired on ${formatCheckoutDate(it)}." }
                ?: "This payment link has expired.",
            moneyLine = NO_MONEY_MOVED,
            nextStep = "Ask $merchant for a new link.",
        )
        LinkAvailability.AlreadyPaid -> Notice(
            heading = "This link has already been paid",
            body = "This is a single-use link and it has already been used.",
            moneyLine = NO_MONEY_MOVED,
            nextStep = "If you were expecting to pay just now, contact $merchant to confirm your payment or request a new link.",
        )
        LinkAvailability.Unknown, LinkAvailability.Payable -> Notice(
            heading = "This link cannot be paid right now",
            body = null,
            moneyLine = NO_MONEY_MOVED,
            nextStep = "Please try again in a moment.",
        )
    }
}

fun notFoundNotice(): Notice = Notice(
    heading = "We couldn't find this link",
    body = "Nothing matches it. It may have been copied in part, or it may no longer exist.",
    moneyLine = NO_MONEY_MOVED,
    nextStep = "Ask whoever sent it to share the link again.",
)

/** The lookup itself failed, so nothing is known about the link. */
fun loadFailedNotice(kind: FailureKind): Notice = Notice(
    heading = "Couldn't load this link",
    body = failureSentence(kind),
    moneyLine = NO_MONEY_MOVED,
    nextStep = "Try again.",
)

/** What the payer reads above the Pay button when starting a payment failed. */
fun payFailureMessage(kind: FailureKind): String = "${failureSentence(kind)} We could not confirm that your payment started. $NO_MONEY_MOVED"

/** A refusal from the API. Adds the money line unless the server said money moved. */
fun rejectionMessage(message: String, moneyMoved: Boolean?): String =
    if (moneyMoved == true) message else "$message $NO_MONEY_MOVED"

fun priceChangedMessage(newAmountKobo: Int?): String = if (newAmountKobo != null) {
    "The price of this link changed to ${Kobo.formatNaira(newAmountKobo)}. Check it, then pay again. $NO_MONEY_MOVED"
} else {
    "The price on this screen didn't match this link, and we couldn't confirm the current price. Reload to check it. $NO_MONEY_MOVED"
}

/** A button's visible text and what a screen reader says instead (it reads "₦" inconsistently). */
data class ButtonLabel(val text: String, val spoken: String)

/**
 * The Pay button. It names the amount once the amount is known (a fixed link, or an open-amount link whose
 * typed value is chargeable), so the payer reads the figure on the very control that spends it. After a
 * failed attempt it says "Try again": same request, same idempotency key.
 */
fun payButtonLabel(fixedAmountKobo: Int?, typedAmount: String, retry: Boolean): ButtonLabel {
    if (retry) return ButtonLabel("Try again", "Try again to start the payment")
    val amountKobo = fixedAmountKobo ?: Kobo.parseNaira(typedAmount)?.takeIf(Kobo::isValidAmountKobo)
    return if (amountKobo != null) {
        ButtonLabel("Pay ${Kobo.formatNaira(amountKobo)}", "Pay ${Kobo.spokenNaira(amountKobo)}")
    } else {
        ButtonLabel("Pay", "Pay")
    }
}

/**
 * What sits above the Pay button after a refusal. When the server pointed at specific fields, the fields
 * carry the detail and this says so; its own message for those is the unhelpful "Validation failed.".
 */
fun rejectionBanner(message: String, hasFieldErrors: Boolean, moneyMoved: Boolean?): String =
    rejectionMessage(if (hasFieldErrors) "Check the highlighted fields." else message, moneyMoved)

/** The letter in the merchant's avatar: the first code point, so an emoji or a surrogate pair is not split in half. */
fun merchantInitial(merchantName: String): String {
    val trimmed = merchantName.trim()
    if (trimmed.isEmpty()) return "?"
    return String(Character.toChars(trimmed.codePointAt(0))).uppercase(Locale.ROOT)
}

/** "kbl_ab3d" read letter by letter, which is how a reference is quoted to a merchant. */
fun spelledOut(reference: String): String = reference.map { if (it == '_') "underscore" else it.toString() }.joinToString(" ")

private fun failureSentence(kind: FailureKind): String = when (kind) {
    FailureKind.Network -> "Your phone couldn't reach Kobolink. Check your connection."
    FailureKind.RateLimited -> "Kobolink is getting too many requests from this device. Wait a moment."
    FailureKind.Server -> "Kobolink had a problem on its side."
    FailureKind.Unreadable -> "Kobolink answered with something this app couldn't read. If this keeps happening, update the app."
    // Neutral about WHO started it: a different person may have adopted an attempt made before their session was known.
    FailureKind.Interrupted -> "A payment on this phone was started earlier and Kobolink never saw how it ended."
}

/**
 * What a REMEMBERED attempt of unknown outcome says on its own screen. It is built from the link and the attempt's
 * amount and nothing else: a payer's name and e-mail have no place in it, because the person looking may not be the
 * person who made the attempt (`CheckoutPrivacyTest` checks every string).
 */
data class AttemptNotice(
    val heading: String,
    val body: String,
    val amountLine: String,
    val spokenAmountLine: String,
    val moneyLine: String,
    val nextStep: String,
)

fun attemptNotice(link: CheckoutLink, pay: PayPhase): AttemptNotice {
    val amount: Int
    val heading: String
    val body: String
    val nextStep: String
    when (pay) {
        is PayPhase.Failed -> {
            amount = pay.request.amountKobo
            heading = "We couldn't confirm your payment"
            body = failureSentence(pay.kind)
            nextStep = "Try again to send the same payment once more, or start a new one if you'd rather."
        }
        is PayPhase.Retrying -> {
            amount = pay.amountKobo
            heading = "Sending your payment again"
            body = "Sending the same payment once more."
            nextStep = "This takes a moment."
        }
        else -> throw IllegalArgumentException("Not a remembered attempt: $pay")
    }
    return AttemptNotice(
        heading = heading,
        body = body,
        amountLine = "${Kobo.formatNaira(amount)} to ${link.merchantName}",
        spokenAmountLine = "${Kobo.spokenNaira(amount)} to ${link.merchantName}",
        // Initialize never posts to the ledger, so this is a fact; it is the same line the in-form failure carries.
        moneyLine = NO_MONEY_MOVED,
        nextStep = nextStep,
    )
}

/**
 * Secure storage would not say, or would not let go. A saved attempt was written BEFORE its request left, so it was
 * almost certainly SENT: this never says nothing was sent. It says one may have been started, and to check with the
 * merchant before paying again.
 */
fun storageBlockedNotice(block: StorageBlock): Notice {
    val body: String
    val nextStep: String
    when (block) {
        StorageBlock.Unreadable -> {
            body = "Kobolink couldn't check this phone's secure storage for a payment you may already have started on this link."
            nextStep = "Unlock your phone and try again. Check with the merchant before paying again."
        }
        StorageBlock.Undecodable -> {
            body = "A payment on this link was saved by a different version of Kobolink, and this version can't read it."
            nextStep = "Check with the merchant before paying again. Starting a new payment forgets the saved one."
        }
        StorageBlock.UndecodableClearFailed -> {
            body = "A payment on this link was saved by a different version of Kobolink. This phone wouldn't let Kobolink forget it, so nothing has changed."
            nextStep = "Try again in a moment. Check with the merchant before paying again."
        }
        StorageBlock.CannotClear -> {
            body = "A payment saved on this phone by an earlier sign-in couldn't be removed, so it isn't shown here."
            nextStep = "Try again in a moment. Check with the merchant before paying again."
        }
        StorageBlock.ObligationUnreadable -> {
            body = "Kobolink couldn't read the record of which saved payments to forget on this phone, so it can't tell which ones are safe to show."
            nextStep = "Check with the merchant before paying again. Resetting checkout data forgets every payment saved on this phone."
        }
        StorageBlock.ResetFailed -> {
            body = "This phone wouldn't let Kobolink finish forgetting the saved checkout data."
            nextStep = "Try again in a moment. Check with the merchant before paying again."
        }
    }
    return Notice(
        heading = "Can't open this payment yet",
        body = body,
        moneyLine = STORAGE_BLOCKED_MONEY_LINE,
        nextStep = nextStep,
    )
}

const val STORAGE_BLOCKED_MONEY_LINE = "A payment may already have been started on this link."

/** "Start a new payment?": names what is forgotten and sends the person to the merchant first, since it may have been paid. */
const val START_OVER_TITLE = "Start a new payment?"

fun startOverMessage(reference: String?, merchant: String): String {
    val what = reference?.let { "payment $it" } ?: "the unfinished payment"
    return "This forgets $what on this phone and starts again. If you already paid, check with $merchant first."
}

/**
 * Said before signing out when a payment was started on this phone and not finished. Neutral about WHO started it: a
 * different person may have adopted an attempt that was made before their session was known.
 */
const val SIGN_OUT_WARNING =
    "A payment on this phone was started and not finished. Signing out forgets it here. If you already paid, check with the merchant first."

/** The sign-out did not happen: what it must clear could not be written down first, so the person is still signed in. */
const val SIGN_OUT_BLOCKED_TITLE = "Couldn't sign out safely"
const val SIGN_OUT_BLOCKED =
    "Kobolink couldn't prepare this phone to forget the payments saved here, so you're still signed in. Try again in a moment."

const val RESET_TITLE = "Reset checkout data?"
const val RESET_MESSAGE =
    "This forgets every payment saved on this phone, and anything a sign-out still owed. If you already paid, check with the merchant first."

/** "Start a new payment" could not clear the record on this phone, so nothing changed: it is still the same payment. */
const val START_OVER_FAILED_MESSAGE =
    "We couldn't clear this payment from your phone, so nothing has changed. Try again; if it keeps happening, restart the app."

/**
 * The payment was NOT sent because this device could not record it first (secure storage unavailable or full). Sending
 * an unrecorded payment could be sent twice after the app is closed, so none is sent.
 */
const val PAY_NOT_RECORDED_MESSAGE =
    "We couldn't save this payment securely on your phone, so we didn't start it. No money was taken. " +
        "Try again; if it keeps happening, restart the app."

/**
 * "7 Oct 2026, 5:00 PM WAT". Pinned to Africa/Lagos and to the zone's own name rather than the phone's zone: a payer
 * abroad would otherwise read a Lagos deadline as their own local time. Same choice, same reason as
 * `formatCheckoutDate` in `apps/web/src/lib/checkout.ts`.
 */
fun formatCheckoutDate(at: OffsetDateTime): String =
    DateTimeFormatter.ofPattern("d MMM yyyy, h:mm a z", Locale.ENGLISH)
        .withZone(ZoneId.of("Africa/Lagos"))
        .format(at)
