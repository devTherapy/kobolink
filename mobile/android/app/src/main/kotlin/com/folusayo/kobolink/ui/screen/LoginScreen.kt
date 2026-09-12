package com.folusayo.kobolink.ui.screen

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Button
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.folusayo.kobolink.auth.AuthenticatedUser
import kotlinx.coroutines.launch

private sealed interface LoginState {
    data object Idle : LoginState
    data object Loading : LoginState
    data class Failed(val message: String) : LoginState
}

/**
 * PLAN.md's M2 row. Signs in against the real `POST /api/auth/login`
 * (`client: "mobile"`) via [login] — [com.folusayo.kobolink.auth.AuthRepository]
 * is what actually calls the API and writes the returned token into
 * encrypted storage; this composable only owns form state and never sees the
 * token itself.
 *
 * M3 only: outlined text fields with the floating label on the outline,
 * fully-rounded filled button (M3's default `Button` shape — never overridden
 * here, same as [LinkLookupScreen]'s), Material Symbols (filled/solid) icons,
 * 48dp-minimum touch target on the submit button, laid out inside the window
 * insets `Scaffold` already applies.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoginScreen(
    login: suspend (email: String, password: String) -> Result<AuthenticatedUser>,
    onLoginSuccess: (AuthenticatedUser) -> Unit,
) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var state by remember { mutableStateOf<LoginState>(LoginState.Idle) }
    val scope = rememberCoroutineScope()
    val passwordFocus = remember { FocusRequester() }

    val canSubmit = email.isNotBlank() && password.isNotBlank() && state != LoginState.Loading

    fun submit() {
        if (!canSubmit) return
        val currentEmail = email.trim()
        val currentPassword = password
        state = LoginState.Loading
        scope.launch {
            login(currentEmail, currentPassword).fold(
                onSuccess = { user ->
                    state = LoginState.Idle
                    onLoginSuccess(user)
                },
                onFailure = { error ->
                    state = LoginState.Failed(error.message ?: "Sign-in failed.")
                },
            )
        }
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text("Sign in") }) }
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
                text = "Sign in to Kobolink to manage your links and wallet.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            OutlinedTextField(
                value = email,
                onValueChange = { email = it; state = LoginState.Idle },
                label = { Text("Email") },
                leadingIcon = { Icon(Icons.Filled.Email, contentDescription = null) },
                singleLine = true,
                isError = state is LoginState.Failed,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    keyboardType = KeyboardType.Email,
                    imeAction = ImeAction.Next,
                ),
                keyboardActions = KeyboardActions(onNext = { passwordFocus.requestFocus() }),
                modifier = Modifier.fillMaxWidth(),
                shape = MaterialTheme.shapes.small,
            )

            OutlinedTextField(
                value = password,
                onValueChange = { password = it; state = LoginState.Idle },
                label = { Text("Password") },
                leadingIcon = { Icon(Icons.Filled.Lock, contentDescription = null) },
                singleLine = true,
                isError = state is LoginState.Failed,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { submit() }),
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(passwordFocus),
                shape = MaterialTheme.shapes.small,
            )

            if (state is LoginState.Failed) {
                ErrorCard((state as LoginState.Failed).message)
            }

            Button(
                onClick = ::submit,
                enabled = canSubmit,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp),
            ) {
                if (state == LoginState.Loading) {
                    CircularProgressIndicator(
                        modifier = Modifier.heightIn(max = 20.dp),
                        color = MaterialTheme.colorScheme.onPrimary,
                        strokeWidth = 2.dp,
                    )
                } else {
                    Text("Sign in")
                }
            }
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
