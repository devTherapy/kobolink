package com.folusayo.kobolink.wallet

import com.folusayo.kobolink.generated.api.infrastructure.Serializer
import com.folusayo.kobolink.generated.api.models.AuthResponse
import com.folusayo.kobolink.generated.api.models.MeResponse
import com.folusayo.kobolink.generated.api.models.TransferResponse
import com.folusayo.kobolink.generated.api.models.Wallet
import com.folusayo.kobolink.generated.api.models.WalletTransactionListResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The generated models are only as good as the generator's reading of the
 * OpenAPI 3.1 document. These decode the exact JSON shapes `apps/api` sends
 * (taken from `packages/contracts/src/wallet.ts` and the B8 integration
 * tests) and pin the two generator problems that made them undecodable:
 *
 * - kobo fields are bare `type: integer`, which the generator maps to a
 *   32-bit Int, but a wallet balance is a ledger SUM bounded only at
 *   MAX_SAFE_INTEGER (about 21.4 million naira overflows an Int);
 * - Zod's `.nullable()` (`anyOf: [T, null]`, `type: [T, "null"]`) came out
 *   as empty wrapper classes / a non-null cursor, so a transfer response
 *   with `counterparty: "Ada"`, a transaction page ending in
 *   `nextCursor: null`, or a login with a phone number threw
 *   JsonDecodingException.
 *
 * See `normalizeOpenApi` and the `typeMappings` in app/build.gradle.kts.
 */
class GeneratedPayloadDecodeTest {

    private val json = Serializer.kotlinxSerializationJson

    @Test
    fun `a wallet balance above Int range decodes`() {
        val wallet = json.decodeFromString(
            Wallet.serializer(),
            """{"accountId":"acc_1","currency":"NGN","balanceKobo":3000000000,"asOf":"2026-10-07T10:00:00Z"}""",
        )
        assertEquals(3_000_000_000L, wallet.balanceKobo)
    }

    @Test
    fun `a transfer response decodes with a named counterparty and a note`() {
        val response = json.decodeFromString(
            TransferResponse.serializer(),
            """{"transaction":{"postingId":"p_1","kind":"transfer","amountKobo":-5000000,"counterparty":"Ada Obi",
              "note":"rent","createdAt":"2026-10-07T10:00:00.123Z"},
              "wallet":{"accountId":"acc_1","currency":"NGN","balanceKobo":9007199254740991,"asOf":"2026-10-07T10:00:00Z"}}""",
        )
        assertEquals("Ada Obi", response.transaction.counterparty)
        assertEquals("rent", response.transaction.note)
        assertEquals(-5_000_000L, response.transaction.amountKobo)
        assertEquals(9_007_199_254_740_991L, response.wallet.balanceKobo)
    }

    @Test
    fun `a transfer response decodes with null counterparty and note`() {
        val response = json.decodeFromString(
            TransferResponse.serializer(),
            """{"transaction":{"postingId":"p_1","kind":"topup","amountKobo":100000,"counterparty":null,
              "note":null,"createdAt":"2026-10-07T10:00:00Z"},
              "wallet":{"accountId":"acc_1","currency":"NGN","balanceKobo":100000,"asOf":"2026-10-07T10:00:00Z"}}""",
        )
        assertNull(response.transaction.counterparty)
        assertNull(response.transaction.note)
    }

    @Test
    fun `the last page of transactions decodes with a null cursor`() {
        val page = json.decodeFromString(
            WalletTransactionListResponse.serializer(),
            """{"items":[{"postingId":"p_2","kind":"transfer","amountKobo":250000,"counterparty":"Chidi",
              "note":null,"createdAt":"2026-10-07T09:00:00Z"}],"nextCursor":null}""",
        )
        assertNull(page.nextCursor)
        assertEquals("Chidi", page.items.single().counterparty)
    }

    @Test
    fun `a middle page of transactions keeps its cursor`() {
        val page = json.decodeFromString(
            WalletTransactionListResponse.serializer(),
            """{"items":[],"nextCursor":"abc123"}""",
        )
        assertEquals("abc123", page.nextCursor)
    }

    @Test
    fun `a login response decodes for a user with a phone number`() {
        val response = json.decodeFromString(
            AuthResponse.serializer(),
            """{"user":{"id":"u_1","role":"customer","email":"a@b.co","phone":"+2348031234567","displayName":"Ada",
              "createdAt":"2026-10-07T10:00:00Z"},"session":{"id":"s_1","expiresAt":"2026-11-07T10:00:00Z"},"token":"t"}""",
        )
        assertEquals("+2348031234567", response.user.phone)
    }

    @Test
    fun `a me response decodes for a user without a phone number`() {
        val response = json.decodeFromString(
            MeResponse.serializer(),
            """{"user":{"id":"u_1","role":"merchant","email":"a@b.co","phone":null,"displayName":"Ada",
              "createdAt":"2026-10-07T10:00:00Z"}}""",
        )
        assertNull(response.user.phone)
    }
}
