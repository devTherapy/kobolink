package com.folusayo.kobolink.ui.screen

import org.junit.Assert.assertEquals
import org.junit.Test

class CheckoutFormStateTest {

    @Test
    fun `a remembered attempt fills an empty form`() {
        val form = CheckoutFormState()
        form.bind("7hK2mQ9x")

        form.restoreIfBlank("15000.00", "Tunde Bello", "tunde@example.com")

        assertEquals("15000.00", form.amountText)
        assertEquals("Tunde Bello", form.name)
        assertEquals("tunde@example.com", form.email)
    }

    @Test
    fun `it never overwrites what the payer has started typing`() {
        val form = CheckoutFormState()
        form.bind("7hK2mQ9x")
        form.name = "Tun"

        form.restoreIfBlank("15000.00", "Tunde Bello", "tunde@example.com")

        assertEquals("Tun", form.name)
        assertEquals("", form.email)
    }
}
