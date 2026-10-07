package com.folusayo.kobolink.wallet

import com.folusayo.kobolink.generated.api.models.WalletTransactionListResponseItemsInner.Kind
import com.folusayo.kobolink.money.Kobo

/** Whether the entry took money out of this wallet. The amount is signed from the wallet's own point of view (contracts' `WalletTransaction`). */
val WalletEntry.isOutgoing: Boolean get() = amountKobo < 0

/** `+₦1,500`, `−₦250.50`; the real minus sign, so a screen reader says "minus", not "dash". */
fun signedNaira(kobo: Long): String = when {
    kobo > 0 -> "+${Kobo.formatNaira(kobo)}"
    kobo < 0 -> "−${Kobo.formatNaira(-kobo)}"
    else -> Kobo.formatNaira(0L)
}

/** The first line of an activity row. */
fun WalletEntry.title(): String = when (kind) {
    Kind.topup -> "Added to wallet"
    Kind.transfer ->
        if (isOutgoing) "Sent to ${counterparty ?: "a Kobolink wallet"}" else "Received from ${counterparty ?: "a Kobolink wallet"}"
    Kind.link_payment ->
        if (isOutgoing) "Link payment" else if (counterparty != null) "Payment from $counterparty" else "Payment received"
}
