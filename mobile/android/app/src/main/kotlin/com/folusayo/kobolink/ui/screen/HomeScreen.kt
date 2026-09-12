package com.folusayo.kobolink.ui.screen

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.folusayo.kobolink.auth.AuthenticatedUser
import com.folusayo.kobolink.generated.api.models.Wallet
import com.folusayo.kobolink.money.Kobo

private sealed interface WalletState {
    data object Loading : WalletState
    data class Loaded(val wallet: Wallet) : WalletState
    data class Failed(val message: String) : WalletState
}

/**
 * PLAN.md's M2 done-when doesn't ask for a real dashboard yet (M3/M4/M5
 * build those) — it asks for proof that the stored session token actually
 * round-trips. [fetchWallet] calls the real, authenticated
 * `GET /api/wallet`: it only succeeds because [com.folusayo.kobolink.auth.AuthInterceptor]
 * attached the `Authorization: Bearer <token>` header from
 * [com.folusayo.kobolink.auth.EncryptedTokenStore] on the way out, and the
 * server accepted it. A [WalletState.Loaded] result here is that proof.
 *
 * Sign-out is the one [androidx.compose.material3.FilledTonalButton] on the
 * screen — a secondary action next to nothing else that competes for
 * attention, exactly the role filled-tonal owns in M3's button hierarchy.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    user: AuthenticatedUser,
    fetchWallet: suspend () -> Result<Wallet>,
    onLogout: () -> Unit,
) {
    var state by remember { mutableStateOf<WalletState>(WalletState.Loading) }

    LaunchedEffect(Unit) {
        state = fetchWallet().fold(
            onSuccess = { WalletState.Loaded(it) },
            onFailure = { WalletState.Failed(it.message ?: "Couldn't load your wallet.") },
        )
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text("Signed in") }) }
    ) { insets ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(insets)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
                shape = MaterialTheme.shapes.large,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(
                    modifier = Modifier.padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Icon(
                        Icons.Filled.AccountCircle,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                    Text(
                        text = user.displayName,
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                    Text(
                        text = user.email,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                }
            }

            Text(
                text = "This wallet card only renders if the session token stored on this " +
                    "device is still accepted by the server on a fresh, authenticated request.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            when (val current = state) {
                is WalletState.Loading -> Column(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    CircularProgressIndicator()
                }
                is WalletState.Loaded -> WalletCard(current.wallet)
                is WalletState.Failed -> ErrorCard(current.message)
            }

            FilledTonalButton(
                onClick = onLogout,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp),
            ) {
                Icon(Icons.AutoMirrored.Filled.ExitToApp, contentDescription = null, modifier = Modifier.padding(end = 8.dp))
                Text("Sign out")
            }
        }
    }
}

@Composable
private fun WalletCard(wallet: Wallet) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                Icons.Filled.CheckCircle,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSecondaryContainer,
            )
            Text(
                text = "Wallet balance",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSecondaryContainer,
            )
            // The ONLY division-by-100 on the Android side lives in
            // Kobo.formatNaira — the generated model's balanceKobo stays an
            // untouched Int right up to this call.
            Text(
                text = Kobo.formatNaira(wallet.balanceKobo),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSecondaryContainer,
            )
        }
    }
}

@Composable
private fun ErrorCard(message: String) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                Icons.Filled.Warning,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onErrorContainer,
            )
            Text(
                text = message,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
        }
    }
}
