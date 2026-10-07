package com.folusayo.kobolink.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.folusayo.kobolink.checkout.CheckoutLink
import com.folusayo.kobolink.checkout.CheckoutState
import com.folusayo.kobolink.checkout.LinkAvailability
import com.folusayo.kobolink.checkout.PayPhase
import com.folusayo.kobolink.checkout.PayerField
import com.folusayo.kobolink.checkout.PayerInput
import com.folusayo.kobolink.checkout.PayerValidation
import com.folusayo.kobolink.checkout.formatCheckoutDate
import com.folusayo.kobolink.checkout.merchantInitial
import com.folusayo.kobolink.checkout.payButtonLabel
import com.folusayo.kobolink.checkout.priceChangedMessage
import com.folusayo.kobolink.checkout.rejectionBanner
import com.folusayo.kobolink.checkout.payFailureMessage
import com.folusayo.kobolink.checkout.validatePayer
import com.folusayo.kobolink.money.Kobo
import com.folusayo.kobolink.ui.theme.paymentColors

/**
 * The payer's checkout: the screen a tapped payment link lands on (docs/DESIGN-SPEC.md 4.3). Stateless;
 * [com.folusayo.kobolink.MainActivity] feeds it [CheckoutController][com.folusayo.kobolink.checkout.CheckoutController]
 * state.
 *
 * One decision, one action: who you are paying and how much, two fields, one Pay button. Every other state
 * the link can be in is a full-screen notice that says what happened, whether money moved, and what to do.
 *
 * Material 3 throughout: type roles from the M3 scale only, colour roles from the tonal scheme (so dark theme
 * is the dark scheme, not an inversion), outlined fields with the floating label on the outline, a fully
 * rounded filled button, 48dp-minimum targets, laid out inside the window insets (the Scaffold applies the
 * system bars, [imePadding] the keyboard). The column scrolls, so the largest font scale and the smallest
 * display size reflow instead of clipping.
 *
 * The one place a stub remains is [PayPhase.Started]: see [PaymentStartedStub].
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CheckoutScreen(
    state: CheckoutState,
    form: CheckoutFormState,
    onPay: (PayerInput) -> Unit,
    onReload: () -> Unit,
    onClose: () -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Checkout") },
                navigationIcon = {
                    IconButton(onClick = onClose) {
                        Icon(Icons.Filled.Close, contentDescription = "Close checkout")
                    }
                },
            )
        },
    ) { insets ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(insets)
                .consumeWindowInsets(insets)
                .imePadding(),
            contentAlignment = Alignment.TopCenter,
        ) {
            Column(
                modifier = Modifier
                    .widthIn(max = 560.dp)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 24.dp, vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                when (state) {
                    CheckoutState.Idle, is CheckoutState.Loading -> CheckoutSkeleton()
                    is CheckoutState.NotFound -> NotFoundNotice(onClose = onClose)
                    is CheckoutState.LoadFailed -> LoadFailedNotice(kind = state.kind, onRetry = onReload, onClose = onClose)
                    is CheckoutState.Loaded -> when {
                        state.availability != LinkAvailability.Payable ->
                            NonPayableNotice(state.availability, state.link, onCheckAgain = onReload, onClose = onClose)
                        state.pay is PayPhase.Started ->
                            PaymentStartedStub(link = state.link, started = state.pay, onDone = onClose)
                        else -> PayableContent(state.link, state.pay, form, onPay)
                    }
                }
            }
        }
    }
}

@Composable
private fun PayableContent(
    link: CheckoutLink,
    pay: PayPhase,
    form: CheckoutFormState,
    onPay: (PayerInput) -> Unit,
) {
    val focus = LocalFocusManager.current
    val submitting = pay is PayPhase.Submitting
    val serverFieldErrors = (pay as? PayPhase.Rejected)?.fieldErrors.orEmpty()
    fun errorFor(field: PayerField): String? = form.errors[field] ?: serverFieldErrors[field]

    fun submit() {
        if (submitting) return
        focus.clearFocus()
        when (val result = validatePayer(link.amountKobo, form.amountText, form.name, form.email)) {
            is PayerValidation.Invalid -> form.errors = result.errors
            is PayerValidation.Valid -> {
                form.errors = emptyMap()
                onPay(result.input)
            }
        }
    }

    MerchantHeader(link)

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = link.title,
            style = MaterialTheme.typography.headlineSmall,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.semantics { heading() },
        )
        link.description?.let {
            Text(
                text = it,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    val fixedAmount = link.amountKobo
    if (fixedAmount != null) {
        AmountCard(fixedAmount)
    } else {
        PayerTextField(
            value = form.amountText,
            onValueChange = { raw ->
                form.amountText = raw.filter { it.isDigit() || it == '.' || it == ',' }.take(16)
                form.clearError(PayerField.Amount)
            },
            label = "Amount",
            enabled = !submitting,
            error = errorFor(PayerField.Amount),
            hint = "${Kobo.formatNaira(Kobo.MIN_AMOUNT_KOBO)} to ${Kobo.formatNaira(Kobo.MAX_AMOUNT_KOBO)}",
            prefix = "₦",
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = ImeAction.Next),
            onNext = { focus.moveFocus(FocusDirection.Down) },
        )
    }

    PayerTextField(
        value = form.name,
        onValueChange = {
            form.name = it
            form.clearError(PayerField.Name)
        },
        label = "Your name",
        enabled = !submitting,
        error = errorFor(PayerField.Name),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Next),
        onNext = { focus.moveFocus(FocusDirection.Down) },
    )
    PayerTextField(
        value = form.email,
        onValueChange = {
            form.email = it
            form.clearError(PayerField.Email)
        },
        label = "Email",
        enabled = !submitting,
        error = errorFor(PayerField.Email),
        hint = "For your receipt",
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Done),
        onNext = { submit() },
    )

    PayBanner(pay)

    val label = payButtonLabel(link.amountKobo, form.amountText, retry = pay is PayPhase.Failed)
    Button(
        onClick = ::submit,
        enabled = !submitting,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .semantics { contentDescription = if (submitting) "Starting payment" else label.spoken },
    ) {
        if (submitting) {
            CircularProgressIndicator(
                modifier = Modifier.size(20.dp),
                strokeWidth = 2.dp,
                color = LocalContentColor.current,
            )
            Spacer(Modifier.width(12.dp))
            Text("Starting payment", style = MaterialTheme.typography.labelLarge)
        } else {
            Text(label.text, style = MaterialTheme.typography.labelLarge)
        }
    }

    link.expiresAt?.let {
        Text(
            text = "This link expires on ${formatCheckoutDate(it)}.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** Avatar initial and the name of whoever is being paid. Read as one phrase: "Paying Ada's Bakery". */
@Composable
private fun MerchantHeader(link: CheckoutLink) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier
            .fillMaxWidth()
            .semantics(mergeDescendants = true) { contentDescription = "Paying ${link.merchantName}" },
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(40.dp)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.primaryContainer),
        ) {
            Text(
                text = merchantInitial(link.merchantName),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = "Pay",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = link.merchantName,
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

/** The fixed price, large. [AmountText] shrinks to fit rather than wrapping a number mid-digit. */
@Composable
private fun AmountCard(amountKobo: Int) {
    val spoken = Kobo.spokenNaira(amountKobo)
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        modifier = Modifier
            .fillMaxWidth()
            .semantics(mergeDescendants = true) { contentDescription = "Amount due, $spoken" },
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = "Amount due",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            // The ONLY division by 100 on the Android side lives in Kobo.formatNaira.
            AmountText(Kobo.formatNaira(amountKobo))
        }
    }
}

/**
 * A single-line amount that scales its font down until it fits the width. At the largest font scale a
 * 72sp "₦10,000,000" is wider than the screen; wrapping a number across lines changes what it reads as,
 * and clipping it hides the figure the payer is about to pay. Shrinking keeps the whole figure visible.
 */
@Composable
private fun AmountText(text: String, modifier: Modifier = Modifier) {
    var scale by remember(text) { mutableFloatStateOf(1f) }
    val base = MaterialTheme.typography.displaySmall
    Text(
        text = text,
        style = base,
        fontSize = base.fontSize * scale,
        lineHeight = base.lineHeight * scale,
        color = MaterialTheme.colorScheme.onSurface,
        maxLines = 1,
        softWrap = false,
        onTextLayout = { layout ->
            if (layout.didOverflowWidth && scale > MIN_AMOUNT_SCALE) scale *= 0.9f
        },
        modifier = modifier,
    )
}

private const val MIN_AMOUNT_SCALE = 0.35f

@Composable
private fun PayerTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    enabled: Boolean,
    error: String?,
    keyboardOptions: KeyboardOptions,
    onNext: () -> Unit,
    hint: String? = null,
    prefix: String? = null,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        prefix = prefix?.let { { Text(it) } },
        singleLine = true,
        enabled = enabled,
        isError = error != null,
        supportingText = (error ?: hint)?.let { message ->
            {
                // Polite live region: a screen reader announces the message when it appears (a failed
                // validation), instead of only when the field is next focused.
                Text(
                    text = message,
                    modifier = if (error != null) Modifier.semantics { liveRegion = LiveRegionMode.Polite } else Modifier,
                )
            }
        },
        keyboardOptions = keyboardOptions,
        keyboardActions = KeyboardActions(onNext = { onNext() }, onDone = { onNext() }),
        modifier = Modifier
            .fillMaxWidth()
            .semantics { if (error != null) this.error(error) },
    )
}

/**
 * What a refused or failed attempt says above the Pay button: what went wrong, whether money moved, and the
 * next step (the button itself reads "Try again" after a failure). Error container for a refusal, the amber
 * payment-state container for a repriced link, which is a notice rather than a mistake.
 */
@Composable
private fun PayBanner(pay: PayPhase) {
    when (pay) {
        is PayPhase.Failed -> Banner(payFailureMessage(pay.kind), BannerTone.Error)
        is PayPhase.Rejected -> Banner(
            rejectionBanner(pay.message, hasFieldErrors = pay.fieldErrors.isNotEmpty(), moneyMoved = pay.moneyMoved),
            BannerTone.Error,
        )
        is PayPhase.PriceChanged -> Banner(priceChangedMessage(pay.newAmountKobo), BannerTone.Warning)
        PayPhase.Idle, PayPhase.Submitting, is PayPhase.Started -> Unit
    }
}

private enum class BannerTone { Error, Warning }

@Composable
private fun Banner(message: String, tone: BannerTone) {
    val container: Color
    val content: Color
    val icon: ImageVector
    when (tone) {
        BannerTone.Error -> {
            container = MaterialTheme.colorScheme.errorContainer
            content = MaterialTheme.colorScheme.onErrorContainer
            icon = Icons.Filled.Warning
        }
        BannerTone.Warning -> {
            container = MaterialTheme.paymentColors.warningContainer
            content = MaterialTheme.paymentColors.onWarningContainer
            icon = Icons.Filled.Info
        }
    }
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = container,
        modifier = Modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Assertive },
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(icon, contentDescription = null, tint = content)
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = content,
                modifier = Modifier.weight(1f),
            )
        }
    }
}
