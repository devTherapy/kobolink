package com.folusayo.kobolink.checkout

import com.folusayo.kobolink.money.Kobo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PayerValidationTest {

    private fun valid(result: PayerValidation) = (result as PayerValidation.Valid).input
    private fun errors(result: PayerValidation) = (result as PayerValidation.Invalid).errors

    @Test
    fun `a fixed-amount link uses the link's amount and ignores whatever was typed`() {
        val input = valid(validatePayer(1_500_000, amountText = "1", name = "Tunde Bello", email = "tunde@example.com"))
        assertEquals(PayerInput(1_500_000, "Tunde Bello", "tunde@example.com"), input)
    }

    @Test
    fun `an open-amount link turns what was typed into integer kobo`() {
        assertEquals(250_050, valid(validatePayer(null, "2,500.50", "Tunde", "t@example.com")).amountKobo)
        assertEquals(1_000_000_000, valid(validatePayer(null, "10,000,000", "Tunde", "t@example.com")).amountKobo)
        assertEquals(10_000, valid(validatePayer(null, "₦100", "Tunde", "t@example.com")).amountKobo)
    }

    @Test
    fun `an amount outside the limits is refused with the limits named`() {
        for (typed in listOf("", "99.99", "10,000,000.01", "abc", "-500", "1.234")) {
            val problems = errors(validatePayer(null, typed, "Tunde", "t@example.com"))
            assertEquals("amount $typed", "Enter an amount between ₦100 and ₦10,000,000.", problems[PayerField.Amount])
        }
    }

    @Test
    fun `the name is trimmed and must be 1 to 80 characters`() {
        assertEquals("Tunde Bello", valid(validatePayer(1_500_000, "", "  Tunde Bello  ", "t@example.com")).name)
        assertEquals("Enter your name.", errors(validatePayer(1_500_000, "", "   ", "t@example.com"))[PayerField.Name])
        assertEquals("Use 80 characters or fewer.", errors(validatePayer(1_500_000, "", "x".repeat(81), "t@example.com"))[PayerField.Name])
        assertEquals(80, valid(validatePayer(1_500_000, "", "x".repeat(80), "t@example.com")).name.length)
    }

    @Test
    fun `the email is trimmed and lower-cased like the contract's EmailSchema`() {
        assertEquals("tunde@example.com", valid(validatePayer(1_500_000, "", "Tunde", "  Tunde@Example.COM ")).email)
    }

    @Test
    fun `an email that cannot be sent to is refused`() {
        for (email in listOf("", "tunde", "tunde@", "@example.com", "tunde@example", "tun de@example.com", "a@@b.com", "a@b..com", "a@.com")) {
            assertEquals("email `$email`", "Enter a valid email address.", errors(validatePayer(1_500_000, "", "Tunde", email))[PayerField.Email])
        }
        assertTrue(valid(validatePayer(1_500_000, "", "Tunde", "tunde+pay@mail.example.ng")).email.contains("+"))
    }

    @Test
    fun `every problem is reported at once`() {
        val problems = errors(validatePayer(null, "", "", ""))
        assertEquals(setOf(PayerField.Amount, PayerField.Name, PayerField.Email), problems.keys)
    }
}
