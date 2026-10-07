package com.folusayo.kobolink.ui.screen

import com.folusayo.kobolink.generated.api.infrastructure.Serializer
import com.folusayo.kobolink.generated.api.models.PublicLinkResponse
import com.folusayo.kobolink.generated.api.models.PublicLinkResponseLink
import java.time.OffsetDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the decisions that determine what a rotation does to
 * [LinkLookupScreen]: what its saved state round-trips to, and whether the
 * deep-link auto-lookup runs again. Plain JVM — no Activity, no Compose.
 */
class LookupStateTest {

    private val json = Serializer.kotlinxSerializationJson

    private val response = PublicLinkResponse(
        state = PublicLinkResponse.State.payable,
        link = PublicLinkResponseLink(
            code = "7hK2mQ9x",
            merchantName = "Ada's Bakery",
            title = "Birthday cake",
            description = null,
            amountKobo = 1_500_000,
            currency = PublicLinkResponseLink.Currency.NGN,
            isReusable = false,
            expiresAt = OffsetDateTime.parse("2030-01-01T10:15:30+01:00"),
        ),
    )

    /** What a rotation does: save, then restore into the recreated screen. */
    private fun rotate(state: LookupState): LookupState =
        restoreLookupState(state.toSaved(json), json)

    @Test
    fun `a resolved link survives rotation`() {
        assertEquals(LookupState.Resolved(response), rotate(LookupState.Resolved(response)))
    }

    @Test
    fun `a failed lookup survives rotation`() {
        assertEquals(LookupState.Failed("Couldn't reach the API."), rotate(LookupState.Failed("Couldn't reach the API.")))
    }

    @Test
    fun `loading does not restore as a stuck spinner`() {
        assertEquals(LookupState.Idle, rotate(LookupState.Loading))
    }

    @Test
    fun `idle stays idle`() {
        assertEquals(LookupState.Idle, rotate(LookupState.Idle))
    }

    @Test
    fun `corrupt or unknown saved state degrades to idle instead of crashing`() {
        assertEquals(LookupState.Idle, restoreLookupState(listOf("resolved", "{not json"), json))
        assertEquals(LookupState.Idle, restoreLookupState(listOf("resolved", null), json))
        assertEquals(LookupState.Idle, restoreLookupState(listOf("from-a-future-version", "x"), json))
        assertEquals(LookupState.Idle, restoreLookupState(emptyList(), json))
    }

    @Test
    fun `a deep link not yet looked up triggers the lookup`() {
        assertTrue(shouldAutoLookUp(initialCode = "7hK2mQ9x", handledCode = null))
    }

    @Test
    fun `an already resolved or failed deep link is not fetched again after rotation`() {
        assertFalse(shouldAutoLookUp(initialCode = "7hK2mQ9x", handledCode = "7hK2mQ9x"))
    }

    @Test
    fun `a different deep link after a handled one does trigger a lookup`() {
        assertTrue(shouldAutoLookUp(initialCode = "Zz3Yy4Xx", handledCode = "7hK2mQ9x"))
    }

    @Test
    fun `no deep link means no automatic lookup`() {
        assertFalse(shouldAutoLookUp(initialCode = null, handledCode = null))
        assertFalse(shouldAutoLookUp(initialCode = null, handledCode = "7hK2mQ9x"))
    }
}
