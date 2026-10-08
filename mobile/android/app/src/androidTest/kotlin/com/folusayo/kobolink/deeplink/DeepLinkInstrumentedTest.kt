package com.folusayo.kobolink.deeplink

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.folusayo.kobolink.MainActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * What only a device can say about the deep link, with the platform's own `PackageManager` and `android.net.Uri`
 * instead of the JVM stand-ins the unit tests use.
 *
 * NOTE: written without an emulator available. It compiles (`compileDebugAndroidTestKotlin`) but has not been run.
 * Run it with `./gradlew :app:connectedDebugAndroidTest` on a Google APIs image. It checks the *intent filter*, which
 * is the part that decides whether Android offers a tapped link to this app. Whether Android also **verifies** the
 * domain (so the tap skips the chooser) depends on the hosted assetlinks.json and is checked with
 * `adb shell pm get-app-links com.folusayo.kobolink`: that is X3's job, not this test's.
 */
@RunWith(AndroidJUnit4::class)
class DeepLinkInstrumentedTest {

    private val context: Context = ApplicationProvider.getApplicationContext()

    private fun viewIntent(url: String) = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        .addCategory(Intent.CATEGORY_BROWSABLE)

    private fun handlers(url: String): List<String> =
        context.packageManager
            .queryIntentActivities(viewIntent(url), PackageManager.MATCH_DEFAULT_ONLY)
            .map { it.activityInfo.packageName }

    @Test
    fun theIntentFilterClaimsPaymentLinksOnTheLinkHost() {
        assertTrue(context.packageName in handlers("https://$LINK_HOST/l/aBcDeFgH"))
        assertTrue(context.packageName in handlers("https://$LINK_HOST/l/aBcDeFgH?utm=whatsapp"))
    }

    @Test
    fun theIntentFilterDoesNotClaimAnythingElseOnThatHost() {
        // docs/DESIGN-SPEC.md 6.1: only /l/* opens the app. The dashboard and the association files must stay in the browser.
        assertFalse(context.packageName in handlers("https://$LINK_HOST/dashboard"))
        assertFalse(context.packageName in handlers("https://$LINK_HOST/.well-known/assetlinks.json"))
        assertFalse(context.packageName in handlers("https://evil.example/l/aBcDeFgH"))
    }

    @Test
    fun theParserAgreesWithAndroidsOwnUriForTheSameLinks() {
        // The unit tests parse with java.net.URI; the app hands the parser `intent.data.toString()`, where `data`
        // is an android.net.Uri. Prove the two spellings of one link give one answer.
        for (url in listOf("https://$LINK_HOST/l/aBcDeFgH", "https://$LINK_HOST/l/aBcDeFgH/?q=a%20b#x")) {
            assertEquals("aBcDeFgH", parseLinkCode(Uri.parse(url).toString()))
        }
        assertNull(parseLinkCode(Uri.parse("https://$LINK_HOST/l/aBcDeFg%48").toString()))
        assertNull(parseLinkCode(Uri.parse("https://evil.example/l/aBcDeFgH").toString()))
    }

    @Test
    fun tappingALinkStartsTheAppOnTheCheckout() {
        val intent = viewIntent("https://$LINK_HOST/l/aBcDeFgH").setClass(context, MainActivity::class.java)
        ActivityScenario.launch<MainActivity>(intent).use { scenario ->
            // It must survive being launched by a link: no crash, and it reaches the foreground. What it then shows depends
            // on the API being reachable from the emulator (10.0.2.2:3001); the screen is covered by the JVM state tests.
            assertEquals(Lifecycle.State.RESUMED, scenario.state)
        }
    }

    @Test
    fun anUnreadableLinkStillStartsTheApp() {
        val intent = viewIntent("https://$LINK_HOST/l/short").setClass(context, MainActivity::class.java)
        ActivityScenario.launch<MainActivity>(intent).use { scenario ->
            assertEquals(Lifecycle.State.RESUMED, scenario.state)
        }
    }
}
