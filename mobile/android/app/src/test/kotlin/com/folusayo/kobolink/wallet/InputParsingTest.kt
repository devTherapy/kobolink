package com.folusayo.kobolink.wallet

import com.folusayo.kobolink.money.Kobo
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The phone and amount rules mirror packages/contracts; these pin both the behaviour and the drift. */
class InputParsingTest {

    private val spec: JsonObject by lazy {
        // Gradle runs JVM tests with the module (`app/`) as the working directory.
        val file = File("../../../apps/api/openapi.json")
        check(file.exists()) { "expected ${file.absolutePath} to exist" }
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun schema(name: String) = spec["components"]!!.jsonObject["schemas"]!!.jsonObject[name]!!.jsonObject

    // ---- phone ----

    @Test
    fun `normalizes the three ways a Nigerian number is typed to E164`() {
        assertEquals("+2348031234567", NigerianPhone.normalize("08031234567"))
        assertEquals("+2348031234567", NigerianPhone.normalize("2348031234567"))
        assertEquals("+2348031234567", NigerianPhone.normalize("+234 803 123 4567"))
        assertEquals("+2348031234567", NigerianPhone.normalize("  0803-123-4567 "))
    }

    @Test
    fun `leaves anything else for validation to reject`() {
        assertFalse(NigerianPhone.isValid(NigerianPhone.normalize("0803123456")))   // one digit short
        assertFalse(NigerianPhone.isValid(NigerianPhone.normalize("08631234567")))  // 6 is not a mobile prefix
        assertFalse(NigerianPhone.isValid(NigerianPhone.normalize("+1 415 555 0100")))
        assertFalse(NigerianPhone.isValid(NigerianPhone.normalize("")))
        assertFalse(NigerianPhone.isValid(NigerianPhone.normalize("0803abc4567")))
    }

    @Test
    fun `accepts the mobile prefixes the contract does`() {
        assertTrue(NigerianPhone.isValid("+2347012345678"))
        assertTrue(NigerianPhone.isValid("+2348112345678"))
        assertTrue(NigerianPhone.isValid("+2349012345678"))
        assertFalse(NigerianPhone.isValid("+2347212345678"))
    }

    @Test
    fun `displays an E164 number in groups`() {
        assertEquals("+234 803 123 4567", NigerianPhone.display("+2348031234567"))
        assertEquals("not a number", NigerianPhone.display("not a number"))
    }

    @Test
    fun `the phone pattern is the one in the OpenAPI document`() {
        val pattern = schema("TransferRequest")["properties"]!!.jsonObject["toPhone"]!!.jsonObject["pattern"]!!.jsonPrimitive.content
        // The document spells digits \d; this app spells them [0-9] so Unicode digits never match.
        assertEquals(pattern.replace("\\d", "[0-9]"), NigerianPhone.E164_PATTERN.pattern)
    }

    // ---- amounts ----

    @Test
    fun `parses what people type into kobo`() {
        assertEquals(150_000L, Kobo.parseNaira("1500"))
        assertEquals(150_000L, Kobo.parseNaira("1,500"))
        assertEquals(150_050L, Kobo.parseNaira("₦1,500.5"))
        assertEquals(150_005L, Kobo.parseNaira("1500.05"))
        assertEquals(50L, Kobo.parseNaira("0.50"))
        assertEquals(10_000L, Kobo.parseNaira("  100  "))
    }

    @Test
    fun `rejects rather than rounds or guesses`() {
        assertNull(Kobo.parseNaira(""))
        assertNull(Kobo.parseNaira("   "))
        assertNull(Kobo.parseNaira("1.234"))
        assertNull(Kobo.parseNaira("-5"))
        assertNull(Kobo.parseNaira("12abc"))
        assertNull(Kobo.parseNaira("1e3"))
        assertNull(Kobo.parseNaira(".5"))
        assertNull(Kobo.parseNaira("1."))
        assertNull(Kobo.parseNaira("12345678901234")) // 14 digits: out of any sane range, refused before it can overflow
    }

    @Test
    fun `parseNaira is the inverse of formatNaira`() {
        for (kobo in listOf(10_000L, 150_005L, 1_000_000_000L, 12_345_678_901L)) {
            val shown = Kobo.formatNaira(kobo, alwaysShowKobo = true)
            assertEquals(kobo, Kobo.parseNaira(shown))
        }
    }

    @Test
    fun `formats balances above the Int range`() {
        assertEquals("₦90,071,992,547,409.91", Kobo.formatNaira(9_007_199_254_740_991L))
    }

    // ---- limits ----

    @Test
    fun `transfer limits match the OpenAPI document`() {
        val amount = schema("TransferRequest")["properties"]!!.jsonObject["amountKobo"]!!.jsonObject
        assertEquals(amount["minimum"]!!.jsonPrimitive.long, TransferLimits.MIN_AMOUNT_KOBO)
        assertEquals(amount["maximum"]!!.jsonPrimitive.long, TransferLimits.MAX_AMOUNT_KOBO)
        val note = schema("TransferRequest")["properties"]!!.jsonObject["note"]!!.jsonObject
        assertEquals(note["maxLength"]!!.jsonPrimitive.long, TransferLimits.NOTE_MAX_LENGTH.toLong())
    }

    // ---- the form ----

    @Test
    fun `a good form becomes a normalised request`() {
        val check = checkSendForm(SendForm(phone = "0803 123 4567", amount = "1,500.50", note = "  rent  "))
        assertEquals(SendFormCheck.Valid("+2348031234567", 150_050L, "rent"), check)
    }

    @Test
    fun `a blank note is no note`() {
        val check = checkSendForm(SendForm(phone = "08031234567", amount = "100", note = "   ")) as SendFormCheck.Valid
        assertNull(check.note)
    }

    @Test
    fun `each bad field gets its own message`() {
        val empty = checkSendForm(SendForm()) as SendFormCheck.Invalid
        assertEquals("Enter the recipient's phone number.", empty.phone)
        assertEquals("Enter an amount.", empty.amount)

        val low = checkSendForm(SendForm(phone = "08031234567", amount = "99.99")) as SendFormCheck.Invalid
        assertNull(low.phone)
        assertEquals("The smallest transfer is ₦100.", low.amount)

        val high = checkSendForm(SendForm(phone = "08031234567", amount = "10,000,000.01")) as SendFormCheck.Invalid
        assertEquals("The largest transfer is ₦10,000,000.", high.amount)

        val garbled = checkSendForm(SendForm(phone = "12345", amount = "abc")) as SendFormCheck.Invalid
        assertEquals("Enter a Nigerian mobile number, like 0803 123 4567.", garbled.phone)
        assertEquals("Use digits only, like 1,500 or 1,500.50.", garbled.amount)

        val longNote = checkSendForm(SendForm(phone = "08031234567", amount = "100", note = "x".repeat(141))) as SendFormCheck.Invalid
        assertEquals("Keep the note under 140 characters.", longNote.note)
    }

    @Test
    fun `the bounds themselves are accepted`() {
        assertTrue(checkSendForm(SendForm(phone = "08031234567", amount = "100")) is SendFormCheck.Valid)
        assertTrue(checkSendForm(SendForm(phone = "08031234567", amount = "10000000")) is SendFormCheck.Valid)
    }
}
