package com.folusayo.kobolink.deeplink

import java.net.URI
import java.net.URISyntaxException

/**
 * The production host that owns `/l/{code}`. Mirrors
 * `LINK_DOMAIN` in `packages/contracts/src/routes.ts` (`pay.folusayo.com`)
 * and the `android:host` this app's `<intent-filter>` claims. Kotlin can't
 * import a TypeScript constant, so this is a hand-kept literal, but two
 * tests pin it from both sides: `DeepLinkTest` reads `LINK_DOMAIN` out of
 * `routes.ts` and `AndroidManifestDeepLinkTest` reads the manifest, so a
 * change in either place fails the build here instead of drifting.
 */
const val LINK_HOST = "pay.folusayo.com"

/** Mirrors `LINK_PATH_PREFIX` in `packages/contracts/src/routes.ts`. */
private const val LINK_PATH_PREFIX = "/l/"

/**
 * Mirrors `IOS_URL_SCHEME` in `packages/contracts/src/routes.ts` — the
 * custom-scheme fallback iOS ships until it has a paid Apple Developer
 * account for Associated Domains. Android doesn't need the fallback (App
 * Links verification is free), but `packages/contracts`' own
 * `parseLinkCode` still accepts it as one of the three URL shapes a link can
 * arrive in, so this mirrors that rather than silently supporting fewer
 * shapes than the platform the code claims to match.
 */
private const val CUSTOM_SCHEME = "kobolink"

/**
 * The link-code shape declared once in `packages/contracts/src/code.ts`
 * (`ALPHABET` without 0/O/1/l/I, `CODE_LENGTH` 8) and generated into
 * `apps/api/openapi.json` as every `code` field's pattern:
 * `^[2-9A-HJ-NP-Za-km-z]{8}$`. There is no generated Kotlin constant for it
 * — the OpenAPI "kotlin" generator emits a plain `val code: kotlin.String`
 * on `PublicLink` with no pattern companion — so this regex is a hand-kept
 * literal copied from that pattern, not a hand-written duplicate of a
 * *model*: if it ever drifted from the real API, the worst case is this
 * client-side pre-validation (used only to fail fast on an obviously
 * malformed link before spending a network call) rejects or accepts a
 * shape it shouldn't; `PublicLinkResponse` itself still round-trips
 * correctly either way since it comes from the generated model, not this.
 */
object LinkCode {
    const val LENGTH = 8
    private val SHAPE = Regex("^[2-9A-HJ-NP-Za-km-z]{$LENGTH}$")

    fun isValid(code: String): Boolean = SHAPE.matches(code)
}

/**
 * Extracts a validated link code from anything a deep link can hand us —
 * `https://pay.folusayo.com/l/aBcDeFgH`, the same with a trailing slash or a
 * `?query#fragment`, a bare `/l/aBcDeFgH` path, or `kobolink://l/aBcDeFgH` —
 * mirroring `packages/contracts/src/routes.ts`'s `parseLinkCode` shape by
 * shape (including its `kobolink://` quirk — that scheme parses with
 * authority/host `"l"` and path `"/{code}"`, so the two are rejoined the
 * same way on both platforms). Anything else — the wrong path, a code of
 * the wrong length or alphabet, an extra path segment, unparseable garbage —
 * resolves to `null`.
 *
 * Where it deliberately differs from contracts, and why:
 *
 * - **Host.** contracts accepts any http(s) origin (the web app also serves
 *   `/l/{code}` on localhost). This parser is handed whatever an *explicit*
 *   intent carries, not only what the verified App Link filter let through,
 *   so for http(s) the host must be [LINK_HOST]. Other schemes are rejected
 *   too: contracts reads `url.pathname` for any scheme, which would accept
 *   `ftp://anything/l/{code}`. (M1 review, item d.)
 *
 * Where it must NOT differ, and used to (M1 review, item c):
 *
 * - **Percent-escapes stay escaped.** contracts reads `url.pathname`, which
 *   keeps `%48` as three characters, so `/l/aBcDeFg%48` is a 10-character
 *   "code" and is rejected. `java.net.URI.getPath()` decodes it to `H` and
 *   used to accept it, so this reads [URI.getRawPath] instead.
 * - **The query and fragment never reach the URI parser.** A space in the
 *   query is legal to WHATWG `new URL`; `java.net.URI` throws on it, and the
 *   old fallback then threw the *whole* link away. Only the part before the
 *   first `?`/`#` can influence the path or host, so only that part is
 *   parsed.
 *
 * Deliberately a pure `String -> String?` function on `java.net.URI`, not
 * `android.net.Uri`: `android.net.Uri.parse` is a native-backed stub outside
 * an instrumented test (it throws `RuntimeException("Stub!")` under plain
 * JUnit), and this module has no Robolectric/instrumentation harness wired
 * up and no running emulator available to add one against in this
 * environment. `java.net.URI` is pure JVM, so the exact code path used by
 * [com.folusayo.kobolink.MainActivity] (`intent.data?.toString()`) is
 * unit-tested for real, not stubbed out.
 *
 * Never throws: a [URISyntaxException] is caught and treated the way
 * `packages/contracts`' `try/catch` does — fall back to the raw text before
 * the first `?`/`#` as the path — so a hand-edited, truncated, or garbage URI
 * that reaches [com.folusayo.kobolink.MainActivity] never crashes the app
 * that just got opened by it.
 */
fun parseLinkCode(input: String): String? {
    val beforeQueryAndFragment = input.takeWhile { it != '?' && it != '#' }

    val path = try {
        val uri = URI(beforeQueryAndFragment)
        when (uri.scheme?.lowercase()) {
            // A bare path such as "/l/aBcDeFgH".
            null -> uri.rawPath // not normalised: contracts falls back to the raw text for a bare path
            CUSTOM_SCHEME -> uri.normalize().let { "/${it.host.orEmpty()}${it.rawPath.orEmpty()}" }
            "https", "http" ->
                if (uri.host.equals(LINK_HOST, ignoreCase = true)) uri.normalize().rawPath else return null
            else -> return null
        }.orEmpty()
    } catch (e: URISyntaxException) {
        beforeQueryAndFragment
    }

    if (!path.startsWith(LINK_PATH_PREFIX)) return null
    val rest = path.removePrefix(LINK_PATH_PREFIX).trimEnd('/')
    return rest.takeIf(LinkCode::isValid)
}
