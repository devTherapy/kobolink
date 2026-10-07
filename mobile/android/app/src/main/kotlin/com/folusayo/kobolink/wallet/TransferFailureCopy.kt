package com.folusayo.kobolink.wallet

import com.folusayo.kobolink.money.Kobo

/** The three lines a failed-transfer screen shows. */
data class FailureText(
    /** What went wrong, in a few words. */
    val title: String,
    /** The specifics: who, how much, and what to do about it. */
    val detail: String,
    /** Whether money moved. Always present, always its own line: it is the first thing a person wants to know. */
    val moneyLine: String,
)

/**
 * Who a payment is to, for a sentence: ALWAYS the phone number. A name that
 * came from a scanned QR code is whatever its creator wrote, so it is never
 * used as the identity of the recipient; screens show it separately and say
 * it is unverified.
 */
fun TransferAttempt.recipientLabel(): String = NigerianPhone.display(toPhone)

/**
 * Words for every way a transfer can fail. Each one says what went wrong and,
 * separately, whether the money moved (PLAN.md's bar for M4, applied to M5).
 *
 * [balanceKobo] is the last balance the app loaded, used only to make
 * "not enough money" concrete; it may be stale, so it is phrased as the
 * balance "shown", never as fact.
 */
fun describeFailure(failure: TransferFailure, attempt: TransferAttempt, balanceKobo: Long?): FailureText {
    val amount = Kobo.formatNaira(attempt.amountKobo)
    val who = attempt.recipientLabel()
    val moneyLine = when (failure.moneyMoved) {
        MoneyMoved.No -> "No money was taken. Your balance is unchanged."
        MoneyMoved.Yes -> "The money was sent."
        MoneyMoved.Unknown ->
            "We can't tell whether the money was sent. Check Recent activity on your wallet before paying again."
    }

    val (title, detail) = when (failure.kind) {
        TransferFailureKind.InsufficientFunds -> "Not enough money in your wallet" to buildString {
            append("You tried to send $amount to $who")
            if (balanceKobo != null) append(", but the balance shown is ${Kobo.formatNaira(balanceKobo)}") else append(", but your wallet doesn't hold that much")
            append(". Send a smaller amount, or add money first.")
        }
        TransferFailureKind.RecipientNotFound -> "No wallet for that number" to
            "Kobolink has no wallet registered to $who. Check the number, or ask them to join Kobolink."
        TransferFailureKind.SelfTransfer -> "That's your own number" to
            "You can't send money to yourself. Enter someone else's phone number."
        TransferFailureKind.InvalidDetails -> "Kobolink couldn't accept those details" to
            (failure.fields.values.flatten().firstOrNull() ?: failure.serverMessage ?: "Check the number and amount, then try again.")
        TransferFailureKind.KeyReusedWithDifferentDetails -> "This payment was already started differently" to
            "A payment with different details was already begun from this screen. Go back and start a new one."
        TransferFailureKind.SessionExpired -> "You've been signed out" to
            "Sign in again, then send $amount to $who."
        TransferFailureKind.RateLimited -> "Too many attempts" to
            "Wait a minute, then try sending $amount to $who again."
        TransferFailureKind.ServerError -> "Kobolink had a problem" to
            "Something went wrong on our side while sending $amount to $who. ${tryAgainHint(failure)}"
        TransferFailureKind.Offline -> "Couldn't confirm the payment" to
            "The connection failed while sending $amount to $who, so we couldn't confirm what happened. ${tryAgainHint(failure)}"
        TransferFailureKind.SecureStorageFailed -> "Couldn't prepare the payment safely" to
            "This phone wouldn't save the payment securely before sending, so $amount to $who was not sent. Try again; if it keeps happening, restart the phone."
        TransferFailureKind.Interrupted -> "This payment didn't finish" to
            "The app closed while sending $amount to $who, so we never saw the result. ${tryAgainHint(failure)}"
        TransferFailureKind.Unreadable -> "Kobolink's reply was unreadable" to
            "The reply to sending $amount to $who couldn't be read. ${tryAgainHint(failure)}"
    }
    return FailureText(title, detail, moneyLine)
}

private fun tryAgainHint(failure: TransferFailure): String =
    if (failure.retryWithSameRequest) {
        "Trying again is safe: it repeats the same request, which Kobolink will not send twice."
    } else {
        "Try again in a moment."
    }
