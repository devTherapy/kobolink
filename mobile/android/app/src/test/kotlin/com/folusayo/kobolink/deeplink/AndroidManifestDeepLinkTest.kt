package com.folusayo.kobolink.deeplink

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `AndroidManifest.xml` is static XML — it can't import `LINK_HOST` or
 * `packages/contracts`' `LINK_DOMAIN`/`LINK_PATH_PREFIX`, so the intent
 * filter's `android:host`/`android:pathPrefix` are literals kept in sync by
 * hand. This test is the tripwire for that drift: it reads the manifest
 * straight off disk and checks the App Links `<intent-filter>` still
 * declares exactly what this module's own Kotlin constants and PLAN.md's
 * acceptance bar expect. It does not (and cannot from a JVM unit test)
 * reach into `packages/contracts` itself — a human changing `LINK_DOMAIN`
 * there still has to update both this repo's TS and this literal by hand —
 * but it does stop the Android manifest and this module's own Kotlin from
 * silently disagreeing with each other.
 */
class AndroidManifestDeepLinkTest {

    private val manifest: String by lazy {
        // Gradle's JVM test working directory is the module root (`app/`),
        // matching every other relative-path assumption already made
        // elsewhere in this build (see app/build.gradle.kts).
        val file = File("src/main/AndroidManifest.xml")
        check(file.exists()) { "expected ${file.absolutePath} to exist" }
        file.readText()
    }

    @Test
    fun `declares an autoVerify App Links intent-filter`() {
        assertTrue(manifest.contains("""android:autoVerify="true""""))
    }

    @Test
    fun `claims the same host this module's LINK_HOST constant does`() {
        assertTrue(
            "manifest host must match LINK_HOST ($LINK_HOST)",
            manifest.contains("""android:host="$LINK_HOST""""),
        )
    }

    @Test
    fun `claims exactly the l slash path prefix, not a wildcard pattern`() {
        assertTrue(manifest.contains("""android:pathPrefix="/l/""""))
        assertTrue(
            "pathPrefix carries no wildcards, so pathPattern must not be used for the App Links data element",
            !manifest.contains("android:pathPattern"),
        )
    }

    @Test
    fun `carries VIEW, BROWSABLE and DEFAULT together — autoVerify silently never runs otherwise`() {
        assertTrue(manifest.contains("android.intent.action.VIEW"))
        assertTrue(manifest.contains("android.intent.category.BROWSABLE"))
        assertTrue(manifest.contains("android.intent.category.DEFAULT"))
    }

    @Test
    fun `claims https, not http`() {
        assertTrue(manifest.contains("""android:scheme="https""""))
    }
}
