package com.folusayo.kobolink.deeplink

import java.net.URI

/**
 * The production host that owns `/l/{code}`. Mirrors
 * `LINK_DOMAIN` in `packages/contracts/src/routes.ts` (`pay.folusayo.com`)
 * and the `android:host` this app's `<intent-filter>` claims in
 * `AndroidManifestDeepLinkTest` — Kotlin can't import a TypeScript
 * constant, so this is a hand-kept-in-sync literal, not a generated one; a
 * reviewer changing `LINK_DOMAIN` needs to update this alongside it.
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
 * Deliberately a pure `String -> String?` function on `java.net.URI`, not
 * `android.net.Uri`: `android.net.Uri.parse` is a native-backed stub outside
 * an instrumented test (it throws `RuntimeException("Stub!")` under plain
 * JUnit), and this module has no Robolectric/instrumentation harness wired
 * up and no running emulator available to add one against in this
 * environment. `java.net.URI` is pure JVM, so the exact code path used by
 * [com.folusayo.kobolink.MainActivity] (`intent.data?.toString()`) is
 * unit-tested for real, not stubbed out.
 *
 * Never throws: `URI(input)` throws `URISyntaxException` on genuinely
 * malformed input (e.g. unescaped spaces), which is caught and treated the
 * same way `packages/contracts`' `try/catch` does — fall back to a manual
 * split on the first `?`/`#` — so a hand-edited, truncated, or garbage URI
 * that reaches [com.folusayo.kobolink.MainActivity] never crashes the app
 * that just got opened by it.
 */
fun parseLinkCode(input: String): String? {
    val path = try {
        val uri = URI(input)
        if (uri.scheme == CUSTOM_SCHEME) {
            "/${uri.host.orEmpty()}${uri.path.orEmpty()}"
        } else {
            uri.path.orEmpty()
        }
    } catch (e: Exception) {
        input.substringBefore('?').substringBefore('#')
    }

    if (!path.startsWith(LINK_PATH_PREFIX)) return null
    val rest = path.removePrefix(LINK_PATH_PREFIX).trimEnd('/')
    return rest.takeIf(LinkCode::isValid)
}
