package com.folusayo.kobolink.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.folusayo.kobolink.checkout.CheckoutLink
import com.folusayo.kobolink.checkout.FailureKind
import com.folusayo.kobolink.checkout.LinkAvailability
import com.folusayo.kobolink.checkout.Notice
import com.folusayo.kobolink.checkout.PayPhase
import com.folusayo.kobolink.checkout.START_OVER_FAILED_MESSAGE
import com.folusayo.kobolink.checkout.loadFailedNotice
import com.folusayo.kobolink.checkout.nonPayableNotice
import com.folusayo.kobolink.checkout.notFoundNotice
import com.folusayo.kobolink.checkout.spelledOut
import com.folusayo.kobolink.money.Kobo
import com.folusayo.kobolink.ui.theme.paymentColors

/** A link that cannot be paid: switched off, expired, already used, or refused mid-payment. Amber: a state to notice. */
@Composable
internal fun NonPayableNotice(
    availability: LinkAvailability,
    link: CheckoutLink,
    onCheckAgain: () -> Unit,
    onClose: () -> Unit,
) {
    NoticeContent(
        notice = nonPayableNotice(availability, link),
        subject = link.merchantName,
        subtitle = link.title,
        icon = Icons.Filled.Warning,
        iconContainer = MaterialTheme.paymentColors.warningContainer,
        iconTint = MaterialTheme.paymentColors.onWarningContainer,
        primary = NoticeAction("Check again", Icons.Filled.Refresh, onCheckAgain),
        onClose = onClose,
    )
}

/** The API has no such link, or the URL held no readable code. Neutral: nothing is wrong with the payer's device or money. */
@Composable
internal fun NotFoundNotice(onClose: () -> Unit) {
    NoticeContent(
        notice = notFoundNotice(),
        subject = null,
        subtitle = null,
        icon = Icons.Filled.Info,
        iconContainer = MaterialTheme.colorScheme.secondaryContainer,
        iconTint = MaterialTheme.colorScheme.onSecondaryContainer,
        primary = null,
        onClose = onClose,
    )
}

/** The lookup failed, so nothing is known about the link. Red container, "Try again" as the one filled action. */
@Composable
internal fun LoadFailedNotice(kind: FailureKind, onRetry: () -> Unit, onClose: () -> Unit) {
    NoticeContent(
        notice = loadFailedNotice(kind),
        subject = null,
        subtitle = null,
        icon = Icons.Filled.Warning,
        iconContainer = MaterialTheme.colorScheme.errorContainer,
        iconTint = MaterialTheme.colorScheme.onErrorContainer,
        primary = NoticeAction("Try again", Icons.Filled.Refresh, onRetry),
        primaryIsFilled = true,
        onClose = onClose,
    )
}

/**
 * **M3 -> M4 stub.** Shown when `POST /api/checkout/initialize` has answered with a pending checkout.
 *
 * What the contract hands back is a `reference` and nothing else: there is no authorization URL to open, since
 * the gateway is simulated and `POST /api/checkout/verify` decides the outcome. So the hand-off to M4 is this
 * state ([PayPhase.Started]): M4 replaces this composable's body with the verify call and the result screens
 * (paid, failed, expired, disabled, already paid). Until then this tells the payer the truth: a payment was
 * started, it has not been confirmed, and no money has moved.
 */
@Composable
internal fun PaymentStartedStub(link: CheckoutLink, started: PayPhase.Started, onDone: () -> Unit, onStartOver: () -> Unit) {
    val reference = started.reference
    var confirmingStartOver by rememberSaveable { mutableStateOf(false) }
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        NoticeIcon(Icons.Filled.Info, MaterialTheme.colorScheme.secondaryContainer, MaterialTheme.colorScheme.onSecondaryContainer)
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        ) {
            Text(
                text = "Payment started",
                style = MaterialTheme.typography.headlineSmall,
                color = MaterialTheme.colorScheme.onSurface,
                textAlign = TextAlign.Center,
                modifier = Modifier.semantics { heading() },
            )
            Text(
                text = "${Kobo.formatNaira(started.amountKobo)} to ${link.merchantName}",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.semantics { contentDescription = "${Kobo.spokenNaira(started.amountKobo)} to ${link.merchantName}" },
            )
        }
        Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainerHigh) {
            Column(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("Reference", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                SelectionContainer {
                    Text(
                        text = reference,
                        // Monospace for references only (docs/DESIGN-SPEC.md): they are read aloud and compared.
                        style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Monospace),
                        color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.semantics { contentDescription = "Reference ${spelledOut(reference)}" },
                    )
                }
            }
        }
        MoneyLine("No money has moved yet. This version of the app can't confirm the payment.")
        Text(
            text = "You can close this screen.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        FilledTonalButton(onClick = onDone, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Text("Done")
        }
        if (started.startOverFailed) {
            Text(
                text = START_OVER_FAILED_MESSAGE,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
                textAlign = TextAlign.Center,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive },
            )
        }
        // The way out for a link that is paid more than once: until M4 can confirm a payment, this one stays on
        // screen every time the link is opened. Deliberate and confirmed, because it may already have been paid.
        TextButton(onClick = { confirmingStartOver = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Text("Start a new payment")
        }
    }

    if (confirmingStartOver) {
        AlertDialog(
            onDismissRequest = { confirmingStartOver = false },
            title = { Text("Start a new payment?") },
            text = {
                Text(
                    "This forgets payment $reference on this phone and starts again. " +
                        "If you already paid, check with ${link.merchantName} first.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmingStartOver = false
                        onStartOver()
                    },
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text("Start a new payment") }
            },
            dismissButton = {
                TextButton(onClick = { confirmingStartOver = false }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Cancel") }
            },
        )
    }
}

private class NoticeAction(val label: String, val icon: ImageVector, val onClick: () -> Unit)

@Composable
private fun NoticeContent(
    notice: Notice,
    subject: String?,
    subtitle: String?,
    icon: ImageVector,
    iconContainer: Color,
    iconTint: Color,
    primary: NoticeAction?,
    onClose: () -> Unit,
    primaryIsFilled: Boolean = false,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        NoticeIcon(icon, iconContainer, iconTint)

        // One polite live region for the words, so a screen reader announces a state that arrives after the
        // screen is already up (a "Check again" that finds the link switched off).
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        ) {
            subject?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
            Text(
                text = notice.heading,
                style = MaterialTheme.typography.headlineSmall,
                color = MaterialTheme.colorScheme.onSurface,
                textAlign = TextAlign.Center,
                modifier = Modifier.semantics { heading() },
            )
            subtitle?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
            notice.body?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
        }

        MoneyLine(notice.moneyLine)

        Text(
            text = notice.nextStep,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )

        val actionModifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
        if (primary != null) {
            val content: @Composable () -> Unit = {
                Icon(primary.icon, contentDescription = null, modifier = Modifier.padding(end = 8.dp))
                Text(primary.label)
            }
            if (primaryIsFilled) {
                Button(onClick = primary.onClick, modifier = actionModifier) { content() }
            } else {
                FilledTonalButton(onClick = primary.onClick, modifier = actionModifier) { content() }
            }
            TextButton(onClick = onClose, modifier = actionModifier) { Text("Close") }
        } else {
            FilledTonalButton(onClick = onClose, modifier = actionModifier) { Text("Close") }
        }
    }
}

/** The line the payer is looking for first. Its own surface so it is never lost in the paragraph above it. */
@Composable
private fun MoneyLine(text: String) {
    Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurface,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun NoticeIcon(icon: ImageVector, container: Color, tint: Color) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(64.dp)
            .clip(CircleShape)
            .background(container),
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(32.dp))
    }
}
