package com.folusayo.kobolink.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * The payment-state hue that Material's scheme has no role for. CLAUDE.md: green, amber and red belong
 * to payment states and the brand accent is never one of them, so these live beside the scheme rather
 * than inside it, and nothing outside a payment-state surface may use them.
 *
 * Red is M3's own `error` role. Amber is [warning]: a link that cannot be paid (switched off, expired,
 * already paid) is a state to notice, not an error the payer caused. Green ("payment succeeded") is M4's
 * result screen; it is deliberately not defined yet, so M3 cannot reach for it.
 *
 * Each pair is checked for contrast in `ContrastTest`.
 */
@Immutable
data class PaymentStateColors(
    val warning: Color,
    val onWarning: Color,
    val warningContainer: Color,
    val onWarningContainer: Color,
)

val LightPaymentStateColors = PaymentStateColors(
    warning = Color(0xFF8A5A00),
    onWarning = Color(0xFFFFFFFF),
    warningContainer = Color(0xFFFFE9BE),
    onWarningContainer = Color(0xFF2B1A00),
)

val DarkPaymentStateColors = PaymentStateColors(
    warning = Color(0xFFFFB94D),
    onWarning = Color(0xFF462B00),
    warningContainer = Color(0xFF633F00),
    onWarningContainer = Color(0xFFFFDDB0),
)

val LocalPaymentStateColors = staticCompositionLocalOf { LightPaymentStateColors }
