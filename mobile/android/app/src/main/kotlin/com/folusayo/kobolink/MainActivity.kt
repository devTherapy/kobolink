package com.folusayo.kobolink

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.folusayo.kobolink.api.ApiClientProvider
import com.folusayo.kobolink.auth.AuthRepository
import com.folusayo.kobolink.auth.AuthenticatedUser
import com.folusayo.kobolink.deeplink.parseLinkCode
import com.folusayo.kobolink.generated.api.models.ApiError
import com.folusayo.kobolink.generated.api.models.PublicLinkResponse
import com.folusayo.kobolink.generated.api.models.Wallet
import com.folusayo.kobolink.ui.screen.HomeScreen
import com.folusayo.kobolink.ui.screen.LinkLookupScreen
import com.folusayo.kobolink.ui.screen.LoginScreen
import com.folusayo.kobolink.ui.screen.toDisplayMessage
import com.folusayo.kobolink.ui.theme.KobolinkTheme
import java.io.IOException
import kotlinx.coroutines.launch
import kotlinx.serialization.SerializationException

/** Where the app is in the sign-in lifecycle — decided once at cold start, then updated by [LoginScreen] and [HomeScreen]'s own callbacks. */
private sealed interface Session {
    data object Resolving : Session
    data object SignedOut : Session
    data class SignedIn(val user: AuthenticatedUser) : Session
}

/**
 * Entry point: a sign-in gate (M2) in front of the App Links flow (M1).
 *
 * `launchMode="singleTask"` (see AndroidManifest.xml) means a link tapped
 * while this activity is already on top delivers here via [onNewIntent]
 * rather than spawning a second instance — without it, opening the same
 * payment link twice from a chat app would stack two activities that both
 * think they're the current screen.
 *
 * Deep link + sign-in: the link code lives in [deepLinkCode], which is
 * independent of [Session] and is never consumed by the sign-in gate. A link
 * received while signed out therefore simply waits: the login screen shows,
 * and once the user is signed in the same code routes to [LinkLookupScreen].
 * Signed in with no pending link, the user lands on [HomeScreen].
 */
class MainActivity : ComponentActivity() {

    private val authRepository by lazy {
        AuthRepository(ApiClientProvider.auth, ApiClientProvider.tokenStore, ApiClientProvider.json)
    }

    // A plain mutableStateOf, not a StateFlow/ViewModel: read as Compose state
    // so onNewIntent's update recomposes the screen already on screen instead
    // of requiring a restart.
    private var deepLinkCode by mutableStateOf<String?>(null)

    // The link code the user backed out of ([BackHandler] below). Remembered so
    // the rotation-safe re-parse in onCreate doesn't resurrect a link the user
    // already dismissed; reset by onNewIntent, because a fresh tap is a fresh
    // request to open it.
    private var dismissedLinkCode: String? = null

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
        deepLinkCode = codeFrom(intent)?.takeUnless { it == dismissedLinkCode }

        setContent {
            KobolinkTheme {
                var session by remember { mutableStateOf<Session>(Session.Resolving) }
                val scope = rememberCoroutineScope()

                // A stored token only proves something was saved once — it
                // may since have expired or been revoked server-side. `/api/
                // auth/me` is the authenticated round trip that confirms the
                // server still honors it before this app trusts it enough to
                // skip straight past the login screen.
                LaunchedEffect(Unit) {
                    session = if (authRepository.isSignedIn) {
                        authRepository.currentUser().fold(
                            onSuccess = { Session.SignedIn(it) },
                            onFailure = {
                                authRepository.forgetLocalSession()
                                Session.SignedOut
                            },
                        )
                    } else {
                        Session.SignedOut
                    }
                }

                when (val current = session) {
                    is Session.Resolving -> ResolvingScreen()
                    is Session.SignedOut -> LoginScreen(
                        login = authRepository::login,
                        onLoginSuccess = { user -> session = Session.SignedIn(user) },
                    )
                    is Session.SignedIn -> {
                        val code = deepLinkCode
                        if (code != null) {
                            BackHandler {
                                dismissedLinkCode = code
                                deepLinkCode = null
                            }
                            LinkLookupScreen(resolveLink = ::resolvePublicLink, initialCode = code)
                        } else {
                            HomeScreen(
                                user = current.user,
                                fetchWallet = ::fetchWallet,
                                onLogout = {
                                    scope.launch {
                                        authRepository.logout()
                                        session = Session.SignedOut
                                    }
                                },
                            )
                        }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        dismissedLinkCode = null
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

    /**
     * `GET /api/wallet` — the authenticated call [HomeScreen] uses as its
     * proof-of-session. Reaches [ApiClientProvider.wallet] the same way
     * [resolvePublicLink] below reaches [ApiClientProvider.links]; the only
     * difference is this one only succeeds when [com.folusayo.kobolink.auth.AuthInterceptor]
     * actually had a token to attach.
     */
    private suspend fun fetchWallet(): Result<Wallet> = try {
        val response = ApiClientProvider.wallet.getWallet()
        val body = response.body()
        if (response.isSuccessful && body != null) {
            Result.success(body)
        } else {
            val apiError = response.errorBody()?.string()?.let { raw ->
                runCatching { ApiClientProvider.json.decodeFromString(ApiError.serializer(), raw) }.getOrNull()
            }
            Result.failure(RuntimeException(apiError?.toDisplayMessage() ?: "Couldn't load your wallet (HTTP ${response.code()})."))
        }
    } catch (e: IOException) {
        Result.failure(RuntimeException("Couldn't reach the API. Check the connection and API_BASE_URL.", e))
    } catch (e: SerializationException) {
        Result.failure(RuntimeException("The API returned something this app couldn't parse.", e))
    }

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
