package com.folusayo.kobolink.ui.wallet

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.folusayo.kobolink.auth.AuthenticatedUser
import com.folusayo.kobolink.generated.api.models.Wallet
import com.folusayo.kobolink.money.Kobo
import com.folusayo.kobolink.ui.icons.QrScannerIcon
import com.folusayo.kobolink.ui.screen.ErrorCard
import com.folusayo.kobolink.wallet.HomeState
import com.folusayo.kobolink.wallet.WalletEntry
import com.folusayo.kobolink.wallet.isOutgoing
import com.folusayo.kobolink.wallet.signedNaira
import com.folusayo.kobolink.wallet.title
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * The wallet home: the derived balance, the two ways to pay, and recent
 * activity.
 *
 * The balance is whatever `GET /api/wallet` last returned, formatted by
 * [Kobo.formatNaira] — a sum of ledger entries computed on the server, never
 * a number this app keeps or adjusts. After a transfer the server's reply
 * carries the new balance and that is what shows.
 *
 * M3 structure: a top app bar (refresh and sign out are 48dp icon buttons), a
 * filled primary action and a filled-tonal secondary one, a `ListItem` per
 * activity row. Everything scrolls in one lazy column so a 200% font scale
 * only makes the page longer, never clips it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WalletHomeScreen(
    user: AuthenticatedUser,
    state: HomeState,
    onLoad: () -> Unit,
    onRefresh: () -> Unit,
    onLoadMore: () -> Unit,
    onSend: () -> Unit,
    onScan: () -> Unit,
    onLogout: () -> Unit,
) {
    LaunchedEffect(Unit) { if (!state.loadedOnce && !state.refreshing) onLoad() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Wallet") },
                actions = {
                    IconButton(onClick = onRefresh, enabled = !state.refreshing) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh balance and activity")
                    }
                    IconButton(onClick = onLogout) {
                        Icon(Icons.AutoMirrored.Filled.ExitToApp, contentDescription = "Sign out")
                    }
                },
            )
        },
    ) { insets ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(insets),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            item(key = "balance") { BalanceCard(userName = user.displayName, state = state, onRetry = onRefresh) }
            item(key = "actions") { ActionRow(onSend = onSend, onScan = onScan) }
            item(key = "activity-title") {
                Text(
                    text = "Recent activity",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
            activitySection(state = state, onRetry = onRefresh, onLoadMore = onLoadMore)
        }
    }
}

@Composable
private fun BalanceCard(userName: String, state: HomeState, onRetry: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
        shape = MaterialTheme.shapes.extraLarge,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = "Hi, $userName",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
            Text(
                text = "Available balance",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
            val wallet: Wallet? = state.wallet
            when {
                wallet != null -> Text(
                    text = Kobo.formatNaira(wallet.balanceKobo),
                    style = MaterialTheme.typography.displaySmall,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                )
                state.walletError == null -> Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    modifier = Modifier.semantics { contentDescription = "Loading your balance" },
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp),
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                        strokeWidth = 3.dp,
                    )
                    Text(
                        text = "Loading balance",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                }
            }
            if (state.walletError != null) {
                // Keep the last balance on screen, and say it may be out of date.
                Text(
                    text = if (wallet != null) {
                        "Couldn't refresh. This is the balance from your last successful load. ${state.walletError}"
                    } else {
                        state.walletError
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                )
                TextButton(
                    onClick = onRetry,
                    enabled = !state.refreshing,
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text("Try again") }
            }
        }
    }
}

/** Two actions side by side; stacked once the font scale would squeeze a label onto three lines. */
@Composable
private fun ActionRow(onSend: () -> Unit, onScan: () -> Unit) {
    val stacked = LocalDensity.current.fontScale >= 1.3f
    val sendButton: @Composable (Modifier) -> Unit = { modifier ->
        Button(onClick = onSend, modifier = modifier.heightIn(min = 48.dp)) {
            Icon(Icons.AutoMirrored.Filled.Send, contentDescription = null, modifier = Modifier.padding(end = 8.dp))
            Text("Send money")
        }
    }
    val scanButton: @Composable (Modifier) -> Unit = { modifier ->
        FilledTonalButton(onClick = onScan, modifier = modifier.heightIn(min = 48.dp)) {
            Icon(QrScannerIcon, contentDescription = null, modifier = Modifier.padding(end = 8.dp))
            Text("Scan to pay")
        }
    }
    if (stacked) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            sendButton(Modifier.fillMaxWidth())
            scanButton(Modifier.fillMaxWidth())
        }
    } else {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            sendButton(Modifier.weight(1f))
            scanButton(Modifier.weight(1f))
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.activitySection(
    state: HomeState,
    onRetry: () -> Unit,
    onLoadMore: () -> Unit,
) {
    when {
        !state.loadedOnce && state.activityError == null -> item(key = "activity-loading") {
            Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(modifier = Modifier.semantics { contentDescription = "Loading recent activity" })
            }
        }
        state.items.isEmpty() && state.activityError != null -> item(key = "activity-error") {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ErrorCard(state.activityError)
                TextButton(onClick = onRetry, modifier = Modifier.heightIn(min = 48.dp)) { Text("Try again") }
            }
        }
        state.items.isEmpty() -> item(key = "activity-empty") {
            Text(
                text = "Nothing here yet. Money you send or receive will show up here.",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(vertical = 8.dp),
            )
        }
        else -> {
            items(state.items, key = { it.postingId }) { entry ->
                ActivityRow(entry)
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
            if (state.activityError != null) {
                item(key = "activity-more-error") {
                    Text(
                        text = state.activityError,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
            if (state.nextCursor != null) {
                item(key = "activity-more") {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        if (state.loadingMore) {
                            CircularProgressIndicator(modifier = Modifier.semantics { contentDescription = "Loading more activity" })
                        } else {
                            TextButton(onClick = onLoadMore, modifier = Modifier.heightIn(min = 48.dp)) { Text("Show older activity") }
                        }
                    }
                }
            }
        }
    }
}

private val ActivityDate: DateTimeFormatter = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)

@Composable
private fun ActivityRow(entry: WalletEntry) {
    val whenText = entry.createdAt.atZoneSameInstant(ZoneId.systemDefault()).format(ActivityDate)
    val outgoing = entry.isOutgoing
    val amount = signedNaira(entry.amountKobo)
    val note = entry.note

    ListItem(
        colors = ListItemDefaults.colors(containerColor = androidx.compose.ui.graphics.Color.Transparent),
        // One spoken sentence per row instead of four fragments.
        modifier = Modifier.semantics(mergeDescendants = true) {
            contentDescription = buildString {
                append(entry.title()).append(", ").append(if (outgoing) "minus " else "plus ")
                append(Kobo.formatNaira(kotlin.math.abs(entry.amountKobo)))
                if (!note.isNullOrBlank()) append(", note: ").append(note)
                append(", ").append(whenText)
            }
        },
        leadingContent = {
            Surface(
                shape = CircleShape,
                color = if (outgoing) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.primaryContainer,
                modifier = Modifier.size(40.dp),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        imageVector = if (outgoing) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                        contentDescription = null,
                        tint = if (outgoing) MaterialTheme.colorScheme.onSecondaryContainer else MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                }
            }
        },
        headlineContent = { Text(entry.title(), style = MaterialTheme.typography.bodyLarge) },
        supportingContent = {
            Column {
                if (!note.isNullOrBlank()) Text(note, style = MaterialTheme.typography.bodyMedium)
                Text(whenText, style = MaterialTheme.typography.bodySmall)
            }
        },
        trailingContent = {
            Text(
                text = amount,
                style = MaterialTheme.typography.titleMedium,
                color = if (outgoing) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.primary,
            )
        },
    )
}
