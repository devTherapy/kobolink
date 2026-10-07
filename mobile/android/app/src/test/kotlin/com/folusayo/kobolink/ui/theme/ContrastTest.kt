package com.folusayo.kobolink.ui.theme

import androidx.compose.ui.graphics.Color
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Contrast, checked rather than eyeballed: every text-on-surface pairing the checkout actually draws, in the light
 * AND the dark scheme, against WCAG 2.x (4.5:1 for text, 3:1 for the non-text boundaries and large display
 * type). Plus the rule from CLAUDE.md that the brand accent is never green.
 *
 * Pairings are named after where they appear so a failure says which screen element broke.
 */
class ContrastTest {

    private class Scheme(
        val name: String,
        val surface: Color, val onSurface: Color, val onSurfaceVariant: Color, val outline: Color,
        val surfaceContainerHigh: Color,
        val primary: Color, val onPrimary: Color, val primaryContainer: Color, val onPrimaryContainer: Color,
        val secondaryContainer: Color, val onSecondaryContainer: Color,
        val error: Color, val errorContainer: Color, val onErrorContainer: Color,
        val payment: PaymentStateColors,
    )

    private val light = Scheme(
        "light",
        surface = surfaceLight, onSurface = onSurfaceLight, onSurfaceVariant = onSurfaceVariantLight, outline = outlineLight,
        surfaceContainerHigh = surfaceContainerHighLight,
        primary = primaryLight, onPrimary = onPrimaryLight, primaryContainer = primaryContainerLight, onPrimaryContainer = onPrimaryContainerLight,
        secondaryContainer = secondaryContainerLight, onSecondaryContainer = onSecondaryContainerLight,
        error = errorLight, errorContainer = errorContainerLight, onErrorContainer = onErrorContainerLight,
        payment = LightPaymentStateColors,
    )

    private val dark = Scheme(
        "dark",
        surface = surfaceDark, onSurface = onSurfaceDark, onSurfaceVariant = onSurfaceVariantDark, outline = outlineDark,
        surfaceContainerHigh = surfaceContainerHighDark,
        primary = primaryDark, onPrimary = onPrimaryDark, primaryContainer = primaryContainerDark, onPrimaryContainer = onPrimaryContainerDark,
        secondaryContainer = secondaryContainerDark, onSecondaryContainer = onSecondaryContainerDark,
        error = errorDark, errorContainer = errorContainerDark, onErrorContainer = onErrorContainerDark,
        payment = DarkPaymentStateColors,
    )

    private fun Scheme.textPairs(): List<Triple<String, Color, Color>> = listOf(
        Triple("title and amount: onSurface on surface", onSurface, surface),
        Triple("description and next step: onSurfaceVariant on surface", onSurfaceVariant, surface),
        Triple("amount card: onSurface on surfaceContainerHigh", onSurface, surfaceContainerHigh),
        Triple("amount card label: onSurfaceVariant on surfaceContainerHigh", onSurfaceVariant, surfaceContainerHigh),
        Triple("Pay button: onPrimary on primary", onPrimary, primary),
        Triple("Close and Try again text, field label focus: primary on surface", primary, surface),
        Triple("merchant avatar: onPrimaryContainer on primaryContainer", onPrimaryContainer, primaryContainer),
        Triple("not-found icon: onSecondaryContainer on secondaryContainer", onSecondaryContainer, secondaryContainer),
        Triple("refusal banner: onErrorContainer on errorContainer", onErrorContainer, errorContainer),
        Triple("field error text: error on surface", error, surface),
        Triple("non-payable notice and price banner: onWarningContainer on warningContainer", payment.onWarningContainer, payment.warningContainer),
        Triple("warning pair: onWarning on warning", payment.onWarning, payment.warning),
    )

    @Test
    fun `every text pairing clears 4_5 to 1 in both schemes`() {
        for (scheme in listOf(light, dark)) {
            for ((where, foreground, background) in scheme.textPairs()) {
                val ratio = contrast(foreground, background)
                assertTrue("${scheme.name}: $where is ${"%.2f".format(ratio)}:1, needs 4.5:1", ratio >= 4.5)
            }
        }
    }

    @Test
    fun `field outlines clear 3 to 1 against the surface in both schemes`() {
        // WCAG 1.4.11: the boundary of an input is what shows where it is.
        for (scheme in listOf(light, dark)) {
            val ratio = contrast(scheme.outline, scheme.surface)
            assertTrue("${scheme.name}: outline is ${"%.2f".format(ratio)}:1, needs 3:1", ratio >= 3.0)
        }
    }

    @Test
    fun `the warning icon clears 3 to 1 against its container`() {
        for (scheme in listOf(light, dark)) {
            val ratio = contrast(scheme.payment.onWarningContainer, scheme.payment.warningContainer)
            assertTrue("${scheme.name}: ${"%.2f".format(ratio)}:1", ratio >= 3.0)
        }
    }

    @Test
    fun `the brand accent is never green`() {
        val accents = mapOf(
            "primaryLight" to primaryLight, "primaryDark" to primaryDark,
            "primaryContainerLight" to primaryContainerLight, "primaryContainerDark" to primaryContainerDark,
            "secondaryLight" to secondaryLight, "secondaryDark" to secondaryDark,
            "tertiaryLight" to tertiaryLight, "tertiaryDark" to tertiaryDark,
            "inversePrimaryLight" to inversePrimaryLight, "inversePrimaryDark" to inversePrimaryDark,
        )
        for ((name, color) in accents) {
            val (hue, saturation) = hueAndSaturation(color)
            val isGreen = saturation > 0.15f && hue in 75f..165f
            assertTrue("$name has hue ${hue.toInt()} at saturation ${"%.2f".format(saturation)}: that reads as green", !isGreen)
        }
    }

    @Test
    fun `payment-state amber is amber, not green or red`() {
        for (colors in listOf(LightPaymentStateColors, DarkPaymentStateColors)) {
            val (hue, _) = hueAndSaturation(colors.warning)
            assertTrue("warning hue ${hue.toInt()}", hue in 30f..50f)
        }
    }

    // ---- WCAG 2.x relative luminance and contrast ratio ------------------------------------

    private fun contrast(a: Color, b: Color): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    private fun luminance(color: Color): Double {
        fun channel(c: Float): Double {
            val v = c.toDouble()
            return if (v <= 0.03928) v / 12.92 else ((v + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * channel(color.red) + 0.7152 * channel(color.green) + 0.0722 * channel(color.blue)
    }

    private fun hueAndSaturation(color: Color): Pair<Float, Float> {
        val r = color.red
        val g = color.green
        val b = color.blue
        val maxC = max(r, max(g, b))
        val minC = min(r, min(g, b))
        val delta = maxC - minC
        if (delta == 0f) return 0f to 0f
        val hue = when (maxC) {
            r -> 60f * (((g - b) / delta) % 6f)
            g -> 60f * ((b - r) / delta + 2f)
            else -> 60f * ((r - g) / delta + 4f)
        }.let { if (it < 0f) it + 360f else it }
        val lightness = (maxC + minC) / 2f
        val saturation = delta / (1f - kotlin.math.abs(2f * lightness - 1f))
        return hue to saturation
    }
}
