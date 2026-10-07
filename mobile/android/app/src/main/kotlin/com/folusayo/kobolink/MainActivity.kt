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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.folusayo.kobolink.api.ApiClientProvider
import com.folusayo.kobolink.auth.SessionState
import com.folusayo.kobolink.checkout.isOpen
import com.folusayo.kobolink.deeplink.parseLinkCode
import com.folusayo.kobolink.generated.api.models.ApiError
import com.folusayo.kobolink.generated.api.models.Wallet
import com.folusayo.kobolink.ui.screen.CheckoutScreen
import com.folusayo.kobolink.ui.screen.HomeScreen
import com.folusayo.kobolink.ui.screen.LoginScreen
import com.folusayo.kobolink.ui.screen.OfflineScreen
import com.folusayo.kobolink.ui.screen.toDisplayMessage
import com.folusayo.kobolink.ui.theme.KobolinkTheme
import java.io.IOException
import kotlinx.serialization.SerializationException

/**
 * Entry point. Two separate flows (docs/DESIGN-SPEC.md 4.3 and 11):
 *
 * - The payer's deep-link landing, the checkout ([CheckoutScreen], M3), is public. An open link shows
 *   whether the session is signed in, signed out, resolving or offline: [route] is the rule.
 * - Merchant sign-in (M2) gates only [HomeScreen] and the wallet.
 *
 * `launchMode="singleTask"` (see AndroidManifest.xml) means a link tapped while this activity is already
 * running delivers here via [onNewIntent] rather than spawning a second instance — without it, opening the
 * same payment link twice from a chat app would stack two activities that both think they're the current
 * screen. Every delivered link starts a fresh lookup, including a re-tap of the link already on screen.
 *
 * Which link is open, and what happened to it, is [MainViewModel.checkout]'s state, not this class's. Back
 * from a checkout is [backFromLink]: to Home for a signed-in merchant, out of the app for everyone else.
 */
class MainActivity : ComponentActivity() {

    // Survives rotation: owns the session (so the cold-start /me check runs once per process, not once per
    // Activity instance) and the checkout (so a rotation neither reloads the link nor drops what was typed).
    private val viewModel: MainViewModel by viewModels { MainViewModel.Factory }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Edge-to-edge, insets applied by Scaffold inside the Compose tree — this app never draws its own
        // status bar or gesture pill.
        enableEdgeToEdge()

        // Which link to open, decided by linkToOpenOnCreate: not on a rotation (the ViewModel has the
        // checkout), the SAVED link after process death (the launch Intent is the original one, not the
        // latest), and never a stale link when started from Recents.
        val link = linkToOpenOnCreate(
            restoredFromSavedState = savedInstanceState != null,
            checkoutIsOpen = viewModel.checkout.state.value.isOpen,
            savedLink = linkRefFromSaved(savedInstanceState?.getString(KEY_OPEN_LINK)),
            fromHistory = intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0,
            intentLink = linkRefFrom(intent),
        )
        viewModel.open(link)

        setContent {
            KobolinkTheme {
                val session by viewModel.sessionState.collectAsState()
                val checkout by viewModel.checkout.state.collectAsState()

                val destination = route(session, linkOpen = checkout.isOpen)

                // Back from a checkout, and the checkout's close button: see backFromLink.
                BackHandler(enabled = destination is Destination.Link) { leaveLink(session) }

                when (destination) {
                    is Destination.Resolving -> ResolvingScreen()
                    is Destination.Offline -> OfflineScreen(message = destination.message, onRetry = viewModel::retry)
                    is Destination.Login -> LoginScreen(
                        login = viewModel::login,
                        // MainViewModel.login has already moved the session to SignedIn.
                        onLoginSuccess = {},
                        notice = destination.notice,
                    )
                    is Destination.Home -> HomeScreen(
                        user = destination.user,
                        fetchWallet = ::fetchWallet,
                        onLogout = viewModel::logout,
                    )
                    is Destination.Link -> CheckoutScreen(
                        state = checkout,
                        form = viewModel.checkoutForm,
                        onPay = viewModel.checkout::pay,
                        onReload = viewModel.checkout::reload,
                        onClose = { leaveLink(session) },
                    )
                }
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(KEY_OPEN_LINK, viewModel.currentLink().toSaved())
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        viewModel.open(linkRefFrom(intent))
    }

    /**
     * The link an Intent carries. An Intent with no data (the launcher bringing an already-running app
     * forward) carries none ([LinkRef.None]) and leaves the screen as it is. Data that
     * [parseLinkCode] rejects is still a link attempt, since the manifest only claims `https` +
     * `pay.folusayo.com` + every path under /l/: it is [LinkRef.Unreadable], the not-found checkout, rather than falling through to the
     * merchant login a payer never asked for.
     */
    private fun linkRefFrom(intent: Intent?): LinkRef {
        if (intent?.action != Intent.ACTION_VIEW) return LinkRef.None
        val data = intent.data?.toString() ?: return LinkRef.None
        return parseLinkCode(data)?.let { LinkRef.Code(it) } ?: LinkRef.Unreadable
    }

    private fun leaveLink(session: SessionState) {
        when (backFromLink(session)) {
            BackAction.DismissLink -> viewModel.closeLink()
            // Not closed first: clearing the checkout would let the merchant login draw for a frame
            // on its way out.
            BackAction.LeaveApp -> finish()
        }
    }

    /**
     * `GET /api/wallet` — the authenticated call [HomeScreen] uses as its
     * proof-of-session. Reaches [ApiClientProvider.wallet] the same way the checkout reaches
     * [ApiClientProvider.links]; the only difference is this one only succeeds when
     * [com.folusayo.kobolink.auth.AuthInterceptor] actually had a token to attach.
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

    private companion object {
        const val KEY_OPEN_LINK = "openLink"
    }
}

@Composable
private fun ResolvingScreen() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}
