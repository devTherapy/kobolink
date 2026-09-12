package com.folusayo.kobolink.ui.screen

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.folusayo.kobolink.generated.api.models.ApiError
import com.folusayo.kobolink.generated.api.models.PublicLinkResponse
import com.folusayo.kobolink.money.Kobo
import kotlinx.coroutines.launch

private sealed interface LookupState {
    data object Idle : LookupState
    data object Loading : LookupState
    data class Resolved(val response: PublicLinkResponse) : LookupState
    data class Failed(val message: String) : LookupState
}

/**
 * Proves the generated-model + Retrofit wiring end to end: type an 8-char
 * link code, call the real `GET /api/links/{code}/public` endpoint (the same
 * unauthenticated resolution the checkout page and both mobile apps use),
 * and render the `PublicLinkResponse` OpenAPI-generated model produced by
 * `openApiGenerate`. Nothing here is a hand-written DTO.
 *
 * M3 only: outlined text field with the floating label on the outline,
 * fully-rounded filled button, filled-tonal result card, Material Symbols
 * (filled/solid) icons, 48dp-minimum touch targets, laid out inside the
 * window insets Scaffold already applies.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LinkLookupScreen(resolveLink: suspend (String) -> Result<PublicLinkResponse>) {
    var code by remember { mutableStateOf("") }
    var state by remember { mutableStateOf<LookupState>(LookupState.Idle) }
    val scope = rememberCoroutineScope()

    Scaffold(
        topBar = {
            TopAppBar(title = { Text("Look up a link") })
        }
    ) { insets ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(insets)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = "Paste a link's 8-character code to resolve it against the live API.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            OutlinedTextField(
                value = code,
                onValueChange = { if (it.length <= 8) code = it.trim() },
                label = { Text("Link code") },
                placeholder = { Text("e.g. 7hK2mQ9x") },
                singleLine = true,
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                ),
                modifier = Modifier.fillMaxWidth(),
                shape = MaterialTheme.shapes.small,
            )

            Button(
                onClick = {
                    val current = code
                    state = LookupState.Loading
                    scope.launch {
                        state = resolveLink(current).fold(
                            onSuccess = { LookupState.Resolved(it) },
                            onFailure = { LookupState.Failed(it.message ?: "Something went wrong.") },
                        )
                    }
                },
                enabled = code.length == 8 && state != LookupState.Loading,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp),
            ) {
                Icon(Icons.Filled.Search, contentDescription = null, modifier = Modifier.padding(end = 8.dp))
                Text("Look up")
            }

            when (val current = state) {
                is LookupState.Idle -> Unit
                is LookupState.Loading -> Column(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    CircularProgressIndicator()
                }
                is LookupState.Resolved -> ResolvedCard(current.response)
                is LookupState.Failed -> ErrorCard(current.message)
            }
        }
    }
}

@Composable
private fun ResolvedCard(response: PublicLinkResponse) {
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
                text = response.link.title,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSecondaryContainer,
            )
            Text(
                text = "From ${response.link.merchantName}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSecondaryContainer,
            )
            // The ONLY division-by-100 on the Android side lives in
            // Kobo.formatNaira — the generated model's amountKobo stays an
            // untouched Int right up to this call.
            val amount = response.link.amountKobo
            Text(
                text = if (amount != null) Kobo.formatNaira(amount) else "Amount set at checkout",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSecondaryContainer,
            )
            Text(
                text = "State: ${response.state}",
                style = MaterialTheme.typography.labelLarge,
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
                textAlign = TextAlign.Start,
            )
        }
    }
}

/** Turns the generated `ApiError` model into the message [ErrorCard] shows. */
fun ApiError.toDisplayMessage(): String = message
