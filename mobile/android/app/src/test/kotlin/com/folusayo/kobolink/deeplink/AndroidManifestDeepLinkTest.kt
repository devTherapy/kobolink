package com.folusayo.kobolink.deeplink

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import org.w3c.dom.NodeList

/**
 * `AndroidManifest.xml` is static XML: it cannot import [LINK_HOST] or `packages/contracts`' `LINK_DOMAIN`/
 * `LINK_PATH_PREFIX`, so the intent filter's `android:host`/`android:pathPrefix` are literals. This is the
 * tripwire for that drift.
 *
 * It parses the manifest as XML and checks the properties of the ONE `<intent-filter>` that carries
 * `autoVerify`, not whether the text appears somewhere in the file. A substring check passes when the
 * pieces are spread across different filters (a `VIEW` here, a `BROWSABLE` there, the host in a third),
 * and that is precisely the arrangement under which Android never runs verification and nothing says why.
 * (M1 review: the old test was string matching.)
 *
 * What it cannot prove, and nothing on the JVM can: that Android actually *verifies* the domain. That is
 * `adb shell pm get-app-links com.folusayo.kobolink` against a served assetlinks.json (X3).
 */
class AndroidManifestDeepLinkTest {

    private val manifest: Element by lazy {
        // Gradle's JVM test working directory is the module root (`app/`).
        val file = File("src/main/AndroidManifest.xml")
        check(file.exists()) { "expected ${file.absolutePath} to exist" }
        DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
            .newDocumentBuilder().parse(file).documentElement
    }

    private val androidNs = "http://schemas.android.com/apk/res/android"

    private fun Element.attr(name: String): String? = getAttributeNS(androidNs, name).takeIf { it.isNotEmpty() }

    private fun NodeList.elements(): List<Element> = (0 until length).mapNotNull { item(it) as? Element }

    private fun Element.children(tag: String): List<Element> = getElementsByTagName(tag).elements()

    private val mainActivity: Element by lazy {
        manifest.children("activity").single { it.attr("name") == ".MainActivity" }
    }

    private val verifiedFilters: List<Element> by lazy {
        mainActivity.children("intent-filter").filter { it.attr("autoVerify") == "true" }
    }

    private val verifiedFilter: Element by lazy {
        assertEquals("exactly one intent-filter may carry autoVerify", 1, verifiedFilters.size)
        verifiedFilters.single()
    }

    private fun Element.values(tag: String) = children(tag).mapNotNull { it.attr("name") }.toSet()

    @Test
    fun `declares exactly one autoVerify intent-filter, on the main activity`() {
        assertEquals(1, verifiedFilters.size)
    }

    @Test
    fun `the verified filter carries VIEW, BROWSABLE and DEFAULT together`() {
        // Spread over several filters, Android would not treat any one of them as an App Link and would
        // never attempt verification, with no error anywhere.
        assertEquals(setOf("android.intent.action.VIEW"), verifiedFilter.values("action"))
        assertEquals(
            setOf("android.intent.category.DEFAULT", "android.intent.category.BROWSABLE"),
            verifiedFilter.values("category"),
        )
    }

    @Test
    fun `the verified filter claims https on the link host and exactly the l prefix`() {
        val data = verifiedFilter.children("data").single()
        assertEquals("https", data.attr("scheme"))
        assertEquals("manifest host must match LINK_HOST ($LINK_HOST)", LINK_HOST, data.attr("host"))
        assertEquals("/l/", data.attr("pathPrefix"))
    }

    @Test
    fun `the claim has no wildcard, path or pattern attributes that could widen it`() {
        val data = verifiedFilter.children("data").single()
        for (widening in listOf("pathPattern", "pathAdvancedPattern", "path", "pathSuffix", "port", "mimeType")) {
            assertEquals("`$widening` would change what the filter claims", null, data.attr(widening))
        }
    }

    @Test
    fun `the launcher filter is separate and is not an App Link`() {
        val launcher = mainActivity.children("intent-filter").single { it.attr("autoVerify") != "true" }
        assertTrue("android.intent.action.MAIN" in launcher.values("action"))
        assertTrue("android.intent.category.LAUNCHER" in launcher.values("category"))
        assertTrue(launcher.children("data").isEmpty())
    }

    @Test
    fun `no other component claims a link`() {
        val others = manifest.children("activity").filter { it !== mainActivity } +
            manifest.children("activity-alias") + manifest.children("service") + manifest.children("receiver")
        assertTrue(others.flatMap { it.children("data") }.isEmpty())
    }

    @Test
    fun `the main activity is exported and single-task, so a link tapped while it runs is delivered to onNewIntent`() {
        assertEquals("true", mainActivity.attr("exported"))
        assertEquals("singleTask", mainActivity.attr("launchMode"))
    }

    @Test
    fun `only the https scheme is claimed`() {
        val schemes = manifest.children("data").mapNotNull { it.attr("scheme") }.toSet()
        assertEquals(setOf("https"), schemes)
        assertFalse("kobolink" in schemes) // the custom scheme is an iOS-development stand-in; Android needs no fallback
        assertNotNull(mainActivity)
    }
}
