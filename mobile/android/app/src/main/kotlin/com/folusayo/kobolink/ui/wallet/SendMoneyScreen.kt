package com.folusayo.kobolink.ui.wallet

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.folusayo.kobolink.money.Kobo
import com.folusayo.kobolink.wallet.FailureText
import com.folusayo.kobolink.wallet.MoneyMoved
import com.folusayo.kobolink.wallet.NigerianPhone
import com.folusayo.kobolink.wallet.SendFormCheck
import com.folusayo.kobolink.wallet.SendPhase
import com.folusayo.kobolink.wallet.SendState
import com.folusayo.kobolink.wallet.TransferAttempt
import com.folusayo.kobolink.wallet.TransferFailure
import com.folusayo.kobolink.wallet.TransferLimits
import com.folusayo.kobolink.wallet.checkSendForm
import com.folusayo.kobolink.wallet.describeFailure
import com.folusayo.kobolink.wallet.recipientLabel
import com.folusayo.kobolink.generated.api.models.TransferResponse
import com.folusayo.kobolink.wallet.SendForm

/** What the send screen asks of its owner. Plain callbacks so the screen holds no logic of its own. */
class SendActions(
    val onEdit: (SendForm) -> Unit,
    val onSubmit: () -> Unit,
    val onCancelConfirmation: () -> Unit,
    val onConfirm: () -> Unit,
    val onTryAgain: () -> Unit,
    val onEditAgain: () -> Unit,
    val onNewPayment: () -> Unit,
    val onDone: () -> Unit,
    val onBack: () -> Unit,
    val onDiscardUnresolved: () -> Unit,
)

/**
 * Send money: the form, the confirmation, the in-flight state and the
 * outcome, one screen so the person never loses their place.
 *
 * Every outcome names what happened and, on its own line, whether money
 * moved. The screen has no state of its own: [state] comes from
 * `SendFlow`, which is where the idempotency key lives.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SendMoneyScreen(
    state: SendState,
    balanceKobo: Long?,
    actions: SendActions,
) {
    val phase = state.phase
    val busy = phase is SendPhase.Sending

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Send money") },
                navigationIcon = {
                    // Absorbed while a request is in flight (see WalletViewModel.back).
                    IconButton(onClick = actions.onBack, enabled = !busy) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { insets ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(insets)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            when (phase) {
                is SendPhase.Editing, is SendPhase.Confirming -> SendFormBody(state, balanceKobo, actions)
                is SendPhase.Sending -> SendingBody(phase.attempt)
                is SendPhase.Sent -> SentBody(phase.attempt, phase.response, actions)
                is SendPhase.Failed -> FailedBody(
                    text = describeFailure(phase.failure, phase.attempt, balanceKobo),
                    failure = phase.failure,
                    actions = actions,
                )
            }
        }
    }

    if (phase is SendPhase.Confirming) ConfirmDialog(phase.attempt, actions)
}

@Composable
private fun SendFormBody(state: SendState, balanceKobo: Long?, actions: SendActions) {
    val form = state.form
    val check = if (state.showErrors) checkSendForm(form) as? SendFormCheck.Invalid else null

    if (form.payeeName != null) {
        // The phone number is who gets the money. The name is only what the
        // QR code's creator wrote: shown, labelled, never trusted.
        Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
            shape = MaterialTheme.shapes.medium,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(modifier = Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = "Scanned from a QR code",
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSecondaryContainer,
                )
                Text(
                    text = NigerianPhone.display(NigerianPhone.normalize(form.phone)),
                    style = MaterialTheme.typography.titleLarge,
                    color = MaterialTheme.colorScheme.onSecondaryContainer,
                )
                Text(
                    text = "Name as written in the QR code: ${form.payeeName}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSecondaryContainer,
                )
                Text(
                    text = "Kobolink has not verified this name. Money goes to the number, so check it is right before you send.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSecondaryContainer,
                )
            }
        }
    }

    OutlinedTextField(
        value = form.phone,
        onValueChange = {
            // Typing a different number means the scanned name no longer describes who is being paid.
            val nameStillApplies = NigerianPhone.normalize(it) == NigerianPhone.normalize(form.phone)
            actions.onEdit(form.copy(phone = it, payeeName = form.payeeName.takeIf { nameStillApplies }))
        },
        label = { Text("Recipient's phone number") },
        leadingIcon = { Icon(Icons.Filled.Phone, contentDescription = null) },
        singleLine = true,
        isError = check?.phone != null,
        supportingText = { Text(check?.phone ?: "A Nigerian mobile number, like 0803 123 4567.") },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone, imeAction = ImeAction.Next),
        shape = MaterialTheme.shapes.small,
        modifier = Modifier.fillMaxWidth(),
    )

    OutlinedTextField(
        value = form.amount,
        onValueChange = { actions.onEdit(form.copy(amount = it)) },
        label = { Text("Amount") },
        prefix = { Text("₦") },
        singleLine = true,
        isError = check?.amount != null,
        supportingText = {
            Text(
                check?.amount ?: buildString {
                    append("Between ${Kobo.formatNaira(TransferLimits.MIN_AMOUNT_KOBO)} and ${Kobo.formatNaira(TransferLimits.MAX_AMOUNT_KOBO)}.")
                    if (balanceKobo != null) append(" Your balance is ${Kobo.formatNaira(balanceKobo)}.")
                },
            )
        },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = ImeAction.Next),
        shape = MaterialTheme.shapes.small,
        modifier = Modifier.fillMaxWidth(),
    )

    OutlinedTextField(
        value = form.note,
        onValueChange = { actions.onEdit(form.copy(note = it)) },
        label = { Text("Note (optional)") },
        singleLine = true,
        isError = check?.note != null,
        supportingText = { Text(check?.note ?: "${form.note.trim().length}/${TransferLimits.NOTE_MAX_LENGTH}") },
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.Sentences,
            keyboardType = KeyboardType.Text,
            imeAction = ImeAction.Done,
        ),
        keyboardActions = KeyboardActions(onDone = { actions.onSubmit() }),
        shape = MaterialTheme.shapes.small,
        modifier = Modifier.fillMaxWidth(),
    )

    Button(
        onClick = actions.onSubmit,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp),
    ) { Text("Review payment") }
}

@Composable
private fun ConfirmDialog(attempt: TransferAttempt, actions: SendActions) {
    AlertDialog(
        onDismissRequest = actions.onCancelConfirmation,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text("Send ${Kobo.formatNaira(attempt.amountKobo)}?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("To ${attempt.recipientLabel()}", style = MaterialTheme.typography.titleMedium)
                if (attempt.payeeName != null) {
                    Text(
                        "Name as written in the QR code, not verified: ${attempt.payeeName}",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                if (attempt.note != null) {
                    Text("Note: ${attempt.note}", style = MaterialTheme.typography.bodyMedium)
                }
                Text(
                    "This leaves your wallet straight away and can't be taken back by Kobolink.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = actions.onConfirm, modifier = Modifier.heightIn(min = 48.dp)) { Text("Send") }
        },
        dismissButton = {
            TextButton(onClick = actions.onCancelConfirmation, modifier = Modifier.heightIn(min = 48.dp)) { Text("Cancel") }
        },
    )
}

@Composable
private fun SendingBody(attempt: TransferAttempt) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 48.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        CircularProgressIndicator()
        Text(
            text = "Sending ${Kobo.formatNaira(attempt.amountKobo)} to ${attempt.recipientLabel()}",
            style = MaterialTheme.typography.titleMedium,
            textAlign = TextAlign.Center,
        )
        Text(
            text = "Stay on this screen until it finishes.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun SentBody(attempt: TransferAttempt, response: TransferResponse, actions: SendActions) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Polite },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        StatusGlyph(container = MaterialTheme.colorScheme.primaryContainer) {
            Icon(Icons.Filled.Check, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer)
        }
        Text(
            text = "${Kobo.formatNaira(attempt.amountKobo)} sent",
            style = MaterialTheme.typography.headlineMedium,
            textAlign = TextAlign.Center,
        )
        Text(
            text = "To ${attempt.recipientLabel()}",
            style = MaterialTheme.typography.bodyLarge,
            textAlign = TextAlign.Center,
        )
        // The wallet's registered name, from the server, not from a QR code.
        response.transaction.counterparty?.let {
            Text(
                text = "Wallet name: $it",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
        Text(
            text = "Your balance is now ${Kobo.formatNaira(response.wallet.balanceKobo)}.",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Button(
            onClick = actions.onDone,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp),
        ) { Text("Done") }
        FilledTonalButton(
            onClick = actions.onNewPayment,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp),
        ) { Text("Send another") }
    }
}

@Composable
private fun FailedBody(text: FailureText, failure: TransferFailure, actions: SendActions) {
    val unknown = failure.moneyMoved == MoneyMoved.Unknown
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Assertive },
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
            shape = MaterialTheme.shapes.medium,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(modifier = Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Filled.Warning, contentDescription = null, tint = MaterialTheme.colorScheme.onErrorContainer)
                Text(text.title, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onErrorContainer)
                Text(text.detail, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onErrorContainer)
            }
        }

        // Whether money moved: its own card, never folded into the error text.
        Card(
            colors = CardDefaults.cardColors(
                containerColor = if (unknown) MaterialTheme.colorScheme.tertiaryContainer else MaterialTheme.colorScheme.secondaryContainer,
            ),
            shape = MaterialTheme.shapes.medium,
            modifier = Modifier.fillMaxWidth(),
        ) {
            val on = if (unknown) MaterialTheme.colorScheme.onTertiaryContainer else MaterialTheme.colorScheme.onSecondaryContainer
            Column(modifier = Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(
                    imageVector = if (unknown) Icons.Filled.Info else Icons.Filled.Check,
                    contentDescription = null,
                    tint = on,
                )
                Text("Did the money move?", style = MaterialTheme.typography.labelLarge, color = on)
                Text(text.moneyLine, style = MaterialTheme.typography.bodyLarge, color = on)
            }
        }

        val fill = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
        if (failure.retryWithSameRequest || (failure.canEditAndResend && failure.worthTryingAgain)) {
            Button(onClick = actions.onTryAgain, modifier = fill) { Text("Try again") }
        }
        if (failure.canEditAndResend) {
            if (failure.worthTryingAgain) {
                FilledTonalButton(onClick = actions.onEditAgain, modifier = fill) { Text("Edit details") }
            } else {
                Button(onClick = actions.onEditAgain, modifier = fill) { Text("Edit details") }
            }
        }
        OutlinedButton(onClick = actions.onDone, modifier = fill) { Text("Back to wallet") }
        if (failure.retryWithSameRequest) {
            var asking by rememberSaveable { mutableStateOf(false) }
            TextButton(onClick = { asking = true }, modifier = fill) { Text("I checked: it didn't go through") }
            if (asking) {
                AlertDialog(
                    onDismissRequest = { asking = false },
                    shape = MaterialTheme.shapes.extraLarge,
                    title = { Text("Forget this payment?") },
                    text = {
                        Text(
                            "Only do this if Recent activity on your wallet does not show it. " +
                                "Once forgotten, Kobolink can no longer tell this payment from a new one, " +
                                "so sending it again could pay twice.",
                        )
                    },
                    confirmButton = {
                        TextButton(
                            onClick = { asking = false; actions.onDiscardUnresolved() },
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) { Text("Forget it") }
                    },
                    dismissButton = {
                        TextButton(onClick = { asking = false }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Keep it") }
                    },
                )
            }
        }
    }
}

@Composable
internal fun StatusGlyph(container: androidx.compose.ui.graphics.Color, content: @Composable () -> Unit) {
    Surface(shape = CircleShape, color = container, modifier = Modifier.size(72.dp)) {
        androidx.compose.foundation.layout.Box(contentAlignment = Alignment.Center) { content() }
    }
}
