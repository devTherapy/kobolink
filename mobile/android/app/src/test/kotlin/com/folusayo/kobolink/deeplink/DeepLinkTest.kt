package com.folusayo.kobolink.deeplink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Mirrors `packages/contracts/tests/routes.test.ts`'s `parseLinkCode`
 * matrix exactly, so the Android and web/API sides of the URL contract are
 * proven to agree rather than merely assumed to. Any accepted/rejected
 * input that diverges here from that file is a real cross-platform bug.
 */
class DeepLinkTest {

    @Test
    fun `extracts the code from every shape a deep link can arrive in`() {
        val accepted = listOf(
            "https://pay.folusayo.com/l/aBcDeFgH",
            "https://pay.folusayo.com/l/aBcDeFgH/",
            "https://pay.folusayo.com/l/aBcDeFgH?utm=whatsapp#x",
            "/l/aBcDeFgH",
            "/l/aBcDeFgH?x=1",
            "kobolink://l/aBcDeFgH",
            // M1 review (c): a space in the query is legal to WHATWG `new URL`
            // (contracts accepts it) but throws in java.net.URI.
            "https://pay.folusayo.com/l/aBcDeFgH?q=a b",
            "https://pay.folusayo.com/l/aBcDeFgH?q=a b#frag ment",
            "https://pay.folusayo.com/l/aBcDeFgH/?q=a b",
            // Hosts are case-insensitive.
            "https://PAY.FOLUSAYO.COM/l/aBcDeFgH",
            // Plain http for the same host is still this host (the manifest claims https only,
            // but an explicit intent may carry either).
            "http://pay.folusayo.com/l/aBcDeFgH",
        )
        for (input in accepted) {
            assertEquals("expected a code from $input", "aBcDeFgH", parseLinkCode(input))
        }
    }

    @Test
    fun `returns null for anything that is not exactly a valid code at that path`() {
        val rejected = listOf(
            "https://pay.folusayo.com/dashboard",
            "https://pay.folusayo.com/.well-known/apple-app-site-association",
            "https://pay.folusayo.com/l/",
            "https://pay.folusayo.com/l/abcdefg0", // '0' is outside the alphabet
            "https://pay.folusayo.com/l/aBcDeFgH/extra",
            "https://pay.folusayo.com/links/aBcDeFgH",
            "kobolink://dashboard",
            "",
            "not a url",
            // M1 review (c): contracts reads `url.pathname`, which keeps percent-escapes verbatim,
            // so '%48' is three characters and the code is 10 long. java.net.URI.getPath() DECODES
            // it to 'H' and used to accept this.
            "https://pay.folusayo.com/l/aBcDeFg%48",
            "https://pay.folusayo.com/l/aBcDeFg%2F",
            "https://pay.folusayo.com/l/aBcDeFgH%20",
            "/l/aBcDeFg%48",
            "kobolink://l/aBcDeFg%48",
        )
        for (input in rejected) {
            assertNull("expected null for $input", parseLinkCode(input))
        }
    }

    /**
     * M1 review (d). `parseLinkCode` is handed whatever an explicit intent carries,
     * not only what the verified App Link filter let through, so the host is part of
     * the contract: only `LINK_HOST` owns `/l/{code}`.
     */
    @Test
    fun `rejects an http(s) link on any host other than the link host`() {
        val rejected = listOf(
            "https://evil.example/l/aBcDeFgH",
            "https://pay.folusayo.com.evil.example/l/aBcDeFgH",
            "https://evilpay.folusayo.com/l/aBcDeFgH",
            "https://pay.folusayo.com@evil.example/l/aBcDeFgH", // userinfo trick: the host is evil.example
            "https://evil.example/pay.folusayo.com/l/aBcDeFgH",
            "https://pay.folusayo.com./l/aBcDeFgH", // trailing dot is a different name
            "http://localhost:3000/l/aBcDeFgH", // contracts accepts this; the app must not
            "https:///l/aBcDeFgH", // no host at all
            "https://sub.pay.folusayo.com/l/aBcDeFgH",
        )
        for (input in rejected) {
            assertNull("expected null for $input", parseLinkCode(input))
        }
    }

    @Test
    fun `rejects schemes that are neither http(s) nor the custom scheme, even on the right path`() {
        for (input in listOf("ftp://pay.folusayo.com/l/aBcDeFgH", "content://pay.folusayo.com/l/aBcDeFgH", "javascript:/l/aBcDeFgH")) {
            assertNull("expected null for $input", parseLinkCode(input))
        }
    }

    @Test
    fun `the link host is the contracts LINK_DOMAIN and the manifest host`() {
        assertEquals(contractsConstant("LINK_DOMAIN"), LINK_HOST)
        assertEquals(contractsConstant("LINK_PATH_PREFIX"), "/l/")
        assertEquals(contractsConstant("IOS_URL_SCHEME"), "kobolink")
        assertEquals(8, LinkCode.LENGTH)
    }

    /**
     * The strongest form of "mirrors contracts": the accepted/rejected lists are read out of
     * `packages/contracts/tests/routes.test.ts` itself, so a case added there is exercised here
     * without anyone remembering to copy it. The ONE deliberate divergence is host: contracts
     * accepts any http(s) origin (it serves the web app on localhost too), the app accepts only
     * [LINK_HOST] (M1 review (d)).
     */
    @Test
    fun `agrees with every case in the contracts routes test, apart from the host rule`() {
        val source = contractsFile("tests/routes.test.ts").readText()
        val accepted = stringsIn(source, "it.each([", "])('extracts the code from %s'")
        val rejected = stringsIn(source, "it.each([", "])('returns null for %s'")
        assertTrue("could not read the accepted cases out of routes.test.ts", accepted.size >= 7)
        assertTrue("could not read the rejected cases out of routes.test.ts", rejected.size >= 9)

        val divergesOnHost = setOf("http://localhost:3000/l/aBcDeFgH")
        for (input in accepted) {
            val expected = if (input in divergesOnHost) null else "aBcDeFgH"
            assertEquals("contracts accepts $input", expected, parseLinkCode(input))
        }
        for (input in rejected) {
            assertNull("contracts rejects $input", parseLinkCode(input))
        }
    }

    @Test
    fun `is case-sensitive and length-exact, matching the OpenAPI code pattern`() {
        assertEquals(8, LinkCode.LENGTH)
        assertEquals(true, LinkCode.isValid("aBcDeFgH"))
        assertEquals(false, LinkCode.isValid("aBcDeFg")) // 7 chars
        assertEquals(false, LinkCode.isValid("aBcDeFgHx")) // 9 chars
        assertEquals(false, LinkCode.isValid("aBcDeFg0")) // '0' excluded
        assertEquals(false, LinkCode.isValid("aBcDeFgO")) // 'O' excluded
        assertEquals(false, LinkCode.isValid("aBcDeFg1")) // '1' excluded
        assertEquals(false, LinkCode.isValid("aBcDeFgI")) // 'I' excluded
        assertEquals(false, LinkCode.isValid("aBcDeFgl")) // lowercase 'l' excluded
    }

    @Test
    fun `never throws on adversarial input`() {
        val adversarial = listOf(
            "://",
            "https://",
            "kobolink://",
            "l/aBcDeFgH",
            "https://pay.folusayo.com/l/aBcDeFgH?".repeat(50),
            "\u0000/l/aBcDeFgH",
        )
        for (input in adversarial) {
            // The assertion is simply that this doesn't throw.
            parseLinkCode(input)
        }
    }

    private fun contractsFile(relative: String): File {
        // Gradle runs JVM tests with the module (`app/`) as the working directory: the repo root is three levels up.
        val file = File("../../../packages/contracts/$relative")
        check(file.exists()) { "expected ${file.absolutePath} to exist; this test reads the contracts package straight off disk" }
        return file
    }

    private fun contractsConstant(name: String): String {
        val source = contractsFile("src/routes.ts").readText()
        val match = Regex("""export const $name = '([^']+)'""").find(source)
        return checkNotNull(match) { "no `export const $name = '…'` in routes.ts" }.groupValues[1]
    }

    /** The single-quoted string literals between [start] and [end]. */
    private fun stringsIn(source: String, start: String, end: String): List<String> {
        val endIndex = source.indexOf(end)
        check(endIndex >= 0) { "marker not found: $end" }
        val startIndex = source.lastIndexOf(start, endIndex)
        check(startIndex >= 0) { "marker not found: $start" }
        return Regex("""'((?:[^'\\]|\\.)*)'""").findAll(source.substring(startIndex, endIndex)).map { it.groupValues[1] }.toList()
    }
}
