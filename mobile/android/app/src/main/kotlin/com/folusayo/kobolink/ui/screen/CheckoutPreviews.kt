package com.folusayo.kobolink.ui.screen

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.folusayo.kobolink.checkout.CheckoutLink
import com.folusayo.kobolink.checkout.CheckoutState
import com.folusayo.kobolink.checkout.FailureKind
import com.folusayo.kobolink.checkout.InitializeRequest
import com.folusayo.kobolink.checkout.LinkAvailability
import com.folusayo.kobolink.checkout.PayPhase
import com.folusayo.kobolink.checkout.PayerField
import com.folusayo.kobolink.checkout.StorageBlock
import com.folusayo.kobolink.ui.theme.KobolinkTheme
import java.time.OffsetDateTime

/**
 * Every screen state at the four conditions the done-when names: light, dark, font scale 1.3, font scale 2.0, plus the
 * narrowest display (320dp at 2.0, the "Display size: largest" case). Open this file in Android Studio's split view to
 * see them all without a device. These are the evidence for "dark theme and large font scale both hold"; the JVM tests
 * cover logic and contrast, not layout.
 */
@Preview(name = "Light", showBackground = true, heightDp = 780)
@Preview(name = "Dark", showBackground = true, heightDp = 780, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Font 1.3", showBackground = true, heightDp = 780, fontScale = 1.3f)
@Preview(name = "Font 2.0", showBackground = true, heightDp = 1100, fontScale = 2f)
@Preview(name = "320dp / Font 2.0 / Dark", showBackground = true, widthDp = 320, heightDp = 1400, fontScale = 2f, uiMode = Configuration.UI_MODE_NIGHT_YES)
annotation class CheckoutPreviews

private val sampleLink = CheckoutLink(
    code = "7hK2mQ9x",
    merchantName = "Ada's Bakery",
    title = "Birthday cake, two tiers",
    description = "Vanilla sponge, buttercream, delivered Saturday morning in Lekki.",
    amountKobo = 1_850_050,
    isReusable = false,
    expiresAt = OffsetDateTime.parse("2026-12-24T17:00:00+01:00"),
)

private val worstCaseLink = sampleLink.copy(
    merchantName = "Olamide & Sons Industrial Supply and Haulage Limited, Ikeja",
    title = "Container haulage deposit, Apapa to Ibadan",
    amountKobo = 1_000_000_000,
)

@Composable
private fun Screen(state: CheckoutState, form: CheckoutFormState = CheckoutFormState()) {
    KobolinkTheme {
        CheckoutScreen(state = state, form = form, onPay = {}, onReload = {}, onStartOver = {}, onClose = {})
    }
}

private fun loaded(link: CheckoutLink = sampleLink, availability: LinkAvailability = LinkAvailability.Payable, pay: PayPhase = PayPhase.Idle) =
    CheckoutState.Loaded(link, availability, pay)

@CheckoutPreviews
@Composable
private fun PayableFixedAmount() = Screen(loaded())

@CheckoutPreviews
@Composable
private fun PayableLargestAmountAndLongNames() = Screen(loaded(worstCaseLink))

@CheckoutPreviews
@Composable
private fun PayableOpenAmount() = Screen(loaded(sampleLink.copy(amountKobo = null, description = null, expiresAt = null)))

@CheckoutPreviews
@Composable
private fun PayableFieldErrors() {
    val form = CheckoutFormState().apply {
        name = "Tunde Bello"
        email = "tunde@"
        errors = mapOf(PayerField.Email to "Enter a valid email address.")
    }
    Screen(loaded(sampleLink.copy(amountKobo = null)), form)
}

@CheckoutPreviews
@Composable
private fun Submitting() {
    val form = CheckoutFormState().apply {
        name = "Tunde Bello"
        email = "tunde@example.com"
    }
    Screen(loaded(pay = PayPhase.Submitting), form)
}

@CheckoutPreviews
@Composable
private fun PayFailedNetwork() = Screen(loaded(pay = PayPhase.Failed(FailureKind.Network, InitializeRequest("7hK2mQ9x", 1_850_050, "Tunde Bello", "tunde@example.com"))))

@CheckoutPreviews
@Composable
private fun PayRefused() =
    Screen(loaded(pay = PayPhase.Rejected("Validation failed.", mapOf(PayerField.Email to "Invalid email address"), null)))

@CheckoutPreviews
@Composable
private fun PriceChanged() = Screen(loaded(pay = PayPhase.PriceChanged(2_000_000)))

@CheckoutPreviews
@Composable
private fun Loading() = Screen(CheckoutState.Loading("7hK2mQ9x"))

@CheckoutPreviews
@Composable
private fun Disabled() = Screen(loaded(availability = LinkAvailability.Disabled))

@CheckoutPreviews
@Composable
private fun Expired() = Screen(loaded(sampleLink.copy(expiresAt = OffsetDateTime.parse("2026-10-01T17:00:00+01:00")), LinkAvailability.Expired))

@CheckoutPreviews
@Composable
private fun AlreadyPaid() = Screen(loaded(availability = LinkAvailability.AlreadyPaid))

@CheckoutPreviews
@Composable
private fun NotFound() = Screen(CheckoutState.NotFound("7hK2mQ9x"))

@CheckoutPreviews
@Composable
private fun LoadFailed() = Screen(CheckoutState.LoadFailed("7hK2mQ9x", FailureKind.Network))

@CheckoutPreviews
@Composable
private fun PaymentStarted() = Screen(loaded(pay = PayPhase.Started("kbl_7hK2mQ9xAb", 1_850_050)))

private val rememberedRequest = InitializeRequest("7hK2mQ9x", 1_850_050, "Tunde Bello", "tunde@example.com")

/** A remembered attempt: no fields, and nothing of the name or e-mail the attempt holds. */
@CheckoutPreviews
@Composable
private fun RememberedAttempt() = Screen(loaded(pay = PayPhase.Failed(FailureKind.Interrupted, rememberedRequest)))

@CheckoutPreviews
@Composable
private fun RememberedAttemptSending() = Screen(loaded(pay = PayPhase.Retrying(1_850_050)))

@CheckoutPreviews
@Composable
private fun RememberedAttemptStartOverFailed() =
    Screen(loaded(pay = PayPhase.Failed(FailureKind.Interrupted, rememberedRequest, startOverFailed = true)))

@CheckoutPreviews
@Composable
private fun StorageBlockedUnreadable() = Screen(CheckoutState.StorageBlocked("7hK2mQ9x", StorageBlock.Unreadable))

@CheckoutPreviews
@Composable
private fun StorageBlockedObligationUnreadable() = Screen(CheckoutState.StorageBlocked("7hK2mQ9x", StorageBlock.ObligationUnreadable))
