package com.folusayo.kobolink

import android.os.Bundle
import androidx.activity.ComponentActivity
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
import com.folusayo.kobolink.generated.api.models.ApiError
import com.folusayo.kobolink.generated.api.models.Wallet
import com.folusayo.kobolink.ui.screen.HomeScreen
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

class MainActivity : ComponentActivity() {

    private val authRepository by lazy {
        AuthRepository(ApiClientProvider.auth, ApiClientProvider.tokenStore, ApiClientProvider.json)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Edge-to-edge, insets applied by Scaffold inside the Compose tree —
        // this app never draws its own status bar or gesture pill.
        enableEdgeToEdge()

        setContent {
            KobolinkTheme {
                var session by remember { mutableStateOf<Session>(Session.Resolving) }
                val scope = rememberCoroutineScope()

                // A stored token only proves something was saved once — it
                // may since have expired or been revoked server-side. `/api/
                // auth/me` is the authenticated round trip that confirms the
                // server still honors it before this app trusts it enough to
                // skip straight to HomeScreen.
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
                    is Session.SignedIn -> HomeScreen(
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
}

@Composable
private fun ResolvingScreen() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}
