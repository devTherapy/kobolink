package com.folusayo.kobolink.ui.screen

import com.folusayo.kobolink.checkout.PayerField
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The form-state half of M3's defect (A): what one person typed is not for whoever opens the same link next on the
 * same phone. [CheckoutFormState.reset] is what [com.folusayo.kobolink.checkout.CheckoutController] calls, in memory
 * and synchronously, on sign-out, a user change, a different link, and Back (those events are tested in
 * `CheckoutSessionTest`; the ViewModel wiring in `MainViewModelTest`).
 */
class CheckoutFormStateTest {

    private fun filled() = CheckoutFormState().apply {
        amountText = "5000"
        name = "Tunde Bello"
        email = "tunde@example.com"
        errors = mapOf(PayerField.Email to "Enter a valid email address.")
        editedSinceRefusal = setOf(PayerField.Name, PayerField.Amount)
    }

    @Test
    fun `a new form is empty`() {
        assertTrue(CheckoutFormState().isEmpty)
    }

    @Test
    fun `reset empties every field and every message about them`() {
        val form = filled()
        assertFalse(form.isEmpty)

        form.reset()

        assertEquals("", form.amountText)
        assertEquals("", form.name)
        assertEquals("", form.email)
        assertTrue(form.errors.isEmpty())
        assertTrue(form.editedSinceRefusal.isEmpty())
        assertTrue(form.isEmpty)
    }

    @Test
    fun `reset empties the amount even when it is the only thing typed`() {
        val form = CheckoutFormState().apply { amountText = "5000" }
        assertFalse(form.isEmpty)

        form.reset()

        assertEquals("", form.amountText)
    }

    @Test
    fun `editing a field drops the message about its old value`() {
        val form = filled()

        form.clearError(PayerField.Email)

        assertTrue(form.errors.isEmpty())
        assertTrue(PayerField.Email in form.editedSinceRefusal)
    }
}
