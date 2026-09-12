package com.folusayo.kobolink

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.folusayo.kobolink.api.ApiClientProvider
import com.folusayo.kobolink.deeplink.parseLinkCode
import com.folusayo.kobolink.generated.api.models.ApiError
import com.folusayo.kobolink.generated.api.models.PublicLinkResponse
import com.folusayo.kobolink.ui.screen.LinkLookupScreen
import com.folusayo.kobolink.ui.screen.toDisplayMessage
import com.folusayo.kobolink.ui.theme.KobolinkTheme
import java.io.IOException
import kotlinx.serialization.SerializationException

/**
 * `launchMode="singleTask"` (see AndroidManifest.xml) means a link tapped
 * while this activity is already on top delivers here via [onNewIntent]
 * rather than spawning a second instance — without it, opening the same
 * payment link twice from a chat app would stack two activities that both
 * think they're the current screen.
 */
class MainActivity : ComponentActivity() {

    // A plain mutableStateOf, not a StateFlow/ViewModel: this activity has no
    // other state to coordinate yet, and M3 (the real checkout screen this
    // routes to once it exists) is exactly the point at which that would
    // change. Read as Compose state so onNewIntent's update recomposes the
    // screen already on screen instead of requiring a restart.
    private var deepLinkCode by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Edge-to-edge, insets applied by Scaffold inside the Compose tree —
        // this app never draws its own status bar or gesture pill.
        enableEdgeToEdge()

        // Guarded on savedInstanceState so a configuration change (e.g.
        // rotation) — which recreates this Activity with the same Intent
        // under singleTask's default configChanges handling — doesn't
        // re-parse and re-trigger LinkLookupScreen's LaunchedEffect lookup
        // for a code already in flight or resolved before the recreation.
        // The resolved/loading state itself is not preserved across the
        // recreation (this stub screen has no Saver for it); M3's real
        // checkout screen should carry state through rotation properly.
        if (savedInstanceState == null) {
            deepLinkCode = codeFrom(intent)
        }

        setContent {
            KobolinkTheme {
                LinkLookupScreen(resolveLink = ::resolvePublicLink, initialCode = deepLinkCode)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        deepLinkCode = codeFrom(intent)
    }

    /**
     * Extracts and validates the link code from an incoming `VIEW` intent's
     * data URI, via [parseLinkCode] — the tested, contracts-mirroring parser
     * in `deeplink/DeepLink.kt`. Returns null for the ordinary launcher
     * intent (no `data`) and for anything [parseLinkCode] itself rejects, so
     * a malformed or unexpected link degrades to the same empty
     * [LinkLookupScreen] a cold app launch shows rather than crashing.
     *
     * `M3` (PLAN.md) is what replaces this: a real checkout screen resolved
     * and rendered directly from the code, not a lookup form pre-filled with
     * it. See `LinkLookupScreen`'s doc comment for the rest of what M3 needs
     * to change here.
     */
    private fun codeFrom(intent: Intent?): String? =
        intent?.data?.toString()?.let(::parseLinkCode)

    private suspend fun resolvePublicLink(code: String): Result<PublicLinkResponse> = try {
        val response = ApiClientProvider.links.resolvePublicLink(code)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            Result.success(body)
        } else {
            val apiError = response.errorBody()?.string()?.let { raw ->
                runCatching { ApiClientProvider.json.decodeFromString(ApiError.serializer(), raw) }.getOrNull()
            }
            Result.failure(RuntimeException(apiError?.toDisplayMessage() ?: "Link lookup failed (HTTP ${response.code()})."))
        }
    } catch (e: IOException) {
        Result.failure(RuntimeException("Couldn't reach the API. Check the connection and API_BASE_URL.", e))
    } catch (e: SerializationException) {
        Result.failure(RuntimeException("The API returned something this app couldn't parse.", e))
    }
}
