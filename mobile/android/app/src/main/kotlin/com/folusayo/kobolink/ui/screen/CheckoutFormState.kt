package com.folusayo.kobolink.ui.screen

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.folusayo.kobolink.checkout.PayerField

/**
 * What the payer has typed, held by [com.folusayo.kobolink.MainViewModel] rather than by the screen.
 *
 * It has to outlive the screen's content: a re-tapped link or a "Check again" swaps the form for a
 * skeleton and back, which would drop plain `remember` state, and a rotation recreates the Activity.
 * Held here it survives both.
 *
 * It is emptied by [reset], and [com.folusayo.kobolink.checkout.CheckoutController] calls that synchronously on
 * every event that must: a different link is opened, the checkout is closed, the person signs out, a different user
 * is confirmed or signs in, and "Start a new payment". What one person typed (a name, an e-mail, an amount) is not
 * for whoever opens the same link next on the same phone.
 *
 * Compose snapshot state, not a `StateFlow`: a text field fed by an asynchronously collected flow can
 * lose or reorder keystrokes; snapshot state is read synchronously in the same frame it is written.
 * Not saved across process death on purpose: it holds the payer's name and email.
 */
class CheckoutFormState {
    var amountText by mutableStateOf("")
    var name by mutableStateOf("")
    var email by mutableStateOf("")

    /** Problems found on this device, per field. A server-side field error arrives through the pay phase instead. */
    var errors by mutableStateOf<Map<PayerField, String>>(emptyMap())

    /**
     * Fields whose server-side error the payer has since edited. The error described the old value, so it stops
     * showing the moment the field changes. Reset on every Pay.
     */
    var editedSinceRefusal by mutableStateOf<Set<PayerField>>(emptySet())

    val isEmpty: Boolean get() = amountText.isEmpty() && name.isEmpty() && email.isEmpty()

    /** Empties every field and every message about them, in memory, now. */
    fun reset() {
        amountText = ""
        name = ""
        email = ""
        errors = emptyMap()
        editedSinceRefusal = emptySet()
    }

    /** The payer edited [field]: whatever was said about its old value (here or by the server) no longer applies. */
    fun clearError(field: PayerField) {
        if (field in errors) errors = errors - field
        editedSinceRefusal = editedSinceRefusal + field
    }
}
