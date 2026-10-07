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
 * Held here it survives both, and is cleared only when a different link is opened ([bind]).
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

    private var boundCode: String? = null

    /** Called whenever a link is opened. Typed values are kept for the same link and dropped for another. */
    fun bind(code: String?) {
        if (code != boundCode) {
            amountText = ""
            name = ""
            email = ""
            errors = emptyMap()
            editedSinceRefusal = emptySet()
            boundCode = code
        }
    }

    /**
     * Puts a remembered attempt's details back into an EMPTY form: after the app was closed and the link re-tapped
     * the form is blank, and "Try again" has to send the identical request to reuse the attempt's idempotency key.
     * A form the payer has already started typing in is never overwritten.
     */
    fun restoreIfBlank(amountText: String, name: String, email: String) {
        if (this.amountText.isNotBlank() || this.name.isNotBlank() || this.email.isNotBlank()) return
        this.amountText = amountText
        this.name = name
        this.email = email
    }

    /** The payer edited [field]: whatever was said about its old value (here or by the server) no longer applies. */
    fun clearError(field: PayerField) {
        if (field in errors) errors = errors - field
        editedSinceRefusal = editedSinceRefusal + field
    }
}
