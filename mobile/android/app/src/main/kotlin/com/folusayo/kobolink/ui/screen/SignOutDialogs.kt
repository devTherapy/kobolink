package com.folusayo.kobolink.ui.screen

import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.folusayo.kobolink.checkout.SIGN_OUT_BLOCKED
import com.folusayo.kobolink.checkout.SIGN_OUT_BLOCKED_TITLE
import com.folusayo.kobolink.checkout.SIGN_OUT_WARNING

/**
 * Said before signing out when a payment made under this session was started on this phone and not finished.
 * Signing out forgets it here; the words are neutral about who started it (see [SIGN_OUT_WARNING]).
 */
@Composable
fun SignOutWarningDialog(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Sign out?") },
        text = { Text(SIGN_OUT_WARNING) },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = Modifier.heightIn(min = 48.dp)) { Text("Sign out") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("Cancel") }
        },
    )
}

/** The sign-out did not happen (the token is kept): what it must clear could not be written down first. */
@Composable
fun SignOutBlockedDialog(onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(SIGN_OUT_BLOCKED_TITLE) },
        text = { Text(SIGN_OUT_BLOCKED) },
        confirmButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("OK") }
        },
    )
}
