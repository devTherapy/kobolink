package com.folusayo.kobolink

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.folusayo.kobolink.api.ApiClientProvider
import com.folusayo.kobolink.auth.SessionState
import com.folusayo.kobolink.deeplink.parseLinkCode
import com.folusayo.kobolink.generated.api.models.ApiError
import com.folusayo.kobolink.generated.api.models.PublicLinkResponse
import com.folusayo.kobolink.ui.screen.LinkLookupScreen
import com.folusayo.kobolink.ui.screen.LoginScreen
import com.folusayo.kobolink.ui.screen.OfflineScreen
import com.folusayo.kobolink.ui.screen.toDisplayMessage
import com.folusayo.kobolink.ui.theme.KobolinkTheme
import com.folusayo.kobolink.ui.wallet.SignedInApp
import com.folusayo.kobolink.wallet.WalletViewModel
import java.io.IOException
import kotlinx.serialization.SerializationException

/**
 * Entry point. Two separate flows (docs/DESIGN-SPEC.md 4.3 and 11):
 *
 * - The payer's deep-link landing ([LinkLookupScreen]; M3 builds the checkout
 *   there) is public. A link code, when present, shows it whether the session
 *   is signed in, signed out, resolving or offline: [route] is the rule.
 * - Sign-in (M2) gates only the signed-in screens: the wallet home, send
 *   money and scan to pay ([SignedInApp], M5).
 *
 * `launchMode="singleTask"` (see AndroidManifest.xml) means a link tapped
 * while this activity is already on top delivers here via [onNewIntent]
 * rather than spawning a second instance — without it, opening the same
 * payment link twice from a chat app would stack two activities that both
 * think they're the current screen.
 *
 * [deepLinkCode] is independent of the session. Back from the link screen
 * clears it, landing on Home if signed in, otherwise on login.
 */
class MainActivity : ComponentActivity() {

    // Survives rotation: owns the session (so the cold-start /me check runs once
    // per process, not once per Activity instance) and the dismissed-link marker.
    private val viewModel: MainViewModel by viewModels { MainViewModel.Factory }

    // The wallet screens' state (balance, activity, the send flow). One per
    // Activity, emptied whenever the session ends so the next person to sign
    // in never sees the previous one's balance.
    private val walletViewModel: WalletViewModel by viewModels { WalletViewModel.Factory }

    // A plain mutableStateOf, not a StateFlow/ViewModel: read as Compose state
    // so onNewIntent's update recomposes the screen already on screen instead
    // of requiring a restart.
    private var deepLinkCode by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Edge-to-edge, insets applied by Scaffold inside the Compose tree —
        // this app never draws its own status bar or gesture pill.
        enableEdgeToEdge()

        // Re-parsed on every onCreate, including a configuration change
        // (e.g. rotation) that recreates this Activity with the same Intent
        // under singleTask's default configChanges handling. Skipping the
        // assignment whenever savedInstanceState was non-null looked like a way
        // to avoid re-triggering LinkLookupScreen's lookup, but it wiped the
        // deep-linked code on rotation; the redundant-lookup problem is solved
        // one layer down instead (LinkLookupScreen's rememberSaveable state
        // plus its LaunchedEffect skipping a code it already has a terminal
        // result for).
        deepLinkCode = codeFrom(intent)?.takeUnless { it == viewModel.dismissedLinkCode }

        setContent {
            KobolinkTheme {
                val session by viewModel.sessionState.collectAsState()

                // Sign-out or an expired token: forget the wallet. Only SignedOut counts: during
                // the cold-start check (Resolving) or a flaky connection (Offline) the same
                // person is still signed in, and an unresolved payment must survive it.
                LaunchedEffect(session is SessionState.SignedOut) {
                    if (session is SessionState.SignedOut) walletViewModel.onSignedOut()
                }

                when (val destination = route(session, deepLinkCode)) {
                    is Destination.Resolving -> ResolvingScreen()
                    is Destination.Offline -> OfflineScreen(message = destination.message, onRetry = viewModel::retry)
                    is Destination.Login -> LoginScreen(
                        login = viewModel::login,
                        // MainViewModel.login has already moved the session to SignedIn.
                        onLoginSuccess = {},
                        notice = destination.notice,
                    )
                    is Destination.Home -> SignedInApp(
                        user = destination.user,
                        viewModel = walletViewModel,
                        onLogout = viewModel::logout,
                    )
                    is Destination.Link -> {
                        // Back leaves the link: to Home if signed in, otherwise to the login screen.
                        BackHandler {
                            viewModel.dismissedLinkCode = destination.code
                            deepLinkCode = null
                        }
                        LinkLookupScreen(resolveLink = ::resolvePublicLink, initialCode = destination.code)
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        viewModel.dismissedLinkCode = null
        deepLinkCode = codeFrom(intent)
    }

    /**
     * Extracts and validates the link code from an incoming `VIEW` intent's
     * data URI, via [parseLinkCode] — the tested, contracts-mirroring parser
     * in `deeplink/DeepLink.kt`. Returns null for the ordinary launcher
     * intent (no `data`) and for anything [parseLinkCode] itself rejects.
     *
     * `M3` (PLAN.md) replaces the lookup stand-in this routes to with a real
     * checkout screen; see `LinkLookupScreen`'s doc comment.
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

@Composable
private fun ResolvingScreen() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}
