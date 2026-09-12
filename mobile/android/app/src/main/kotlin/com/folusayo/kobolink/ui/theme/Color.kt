package com.folusayo.kobolink.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * M3 tonal palette derived from the Kobolink brand hue, `#1F44D8`
 * (docs/DESIGN-SPEC.md). Every role below is a tone on the same blue hue
 * (or its neutral/secondary/tertiary siblings), not an ad hoc hex pick — the
 * brand color itself sits at roughly the "primary" tone (40) on its own
 * ramp, so it is used directly as `primaryLight`.
 *
 * These are hand-derived approximations of what Material Theme Builder
 * would output for this seed; a full HCT-generated scheme (via
 * material-color-utilities, including dynamic color on Android 12+) is a
 * reasonable follow-up once there is a real screen to theme, not something
 * this scaffold needs to get exactly right.
 */

// Primary — the brand blue itself.
val primaryLight = Color(0xFF1F44D8)
val onPrimaryLight = Color(0xFFFFFFFF)
val primaryContainerLight = Color(0xFFDEE1FF)
val onPrimaryContainerLight = Color(0xFF00174B)

val primaryDark = Color(0xFFBAC3FF)
val onPrimaryDark = Color(0xFF00229C)
val primaryContainerDark = Color(0xFF142FA0)
val onPrimaryContainerDark = Color(0xFFDEE1FF)

// Secondary — a muted blue-gray off the same hue.
val secondaryLight = Color(0xFF5B5D72)
val onSecondaryLight = Color(0xFFFFFFFF)
val secondaryContainerLight = Color(0xFFE0E1F9)
val onSecondaryContainerLight = Color(0xFF181A2C)

val secondaryDark = Color(0xFFC4C5DD)
val onSecondaryDark = Color(0xFF2D2F42)
val secondaryContainerDark = Color(0xFF434559)
val onSecondaryContainerDark = Color(0xFFE0E1F9)

// Tertiary — a muted complement, never the green/amber/red reserved for
// payment states.
val tertiaryLight = Color(0xFF78536A)
val onTertiaryLight = Color(0xFFFFFFFF)
val tertiaryContainerLight = Color(0xFFFFD8EC)
val onTertiaryContainerLight = Color(0xFF2E1124)

val tertiaryDark = Color(0xFFE9B9D6)
val onTertiaryDark = Color(0xFF46263C)
val tertiaryContainerDark = Color(0xFF5F3C53)
val onTertiaryContainerDark = Color(0xFFFFD8EC)

// Error / neutral — M3 baseline tones (hue-neutral by design; payment-state
// green/amber/red live in the checkout screen built in M3/M4, not here).
val errorLight = Color(0xFFBA1A1A)
val onErrorLight = Color(0xFFFFFFFF)
val errorContainerLight = Color(0xFFFFDAD6)
val onErrorContainerLight = Color(0xFF410002)

val errorDark = Color(0xFFFFB4AB)
val onErrorDark = Color(0xFF690005)
val errorContainerDark = Color(0xFF93000A)
val onErrorContainerDark = Color(0xFFFFDAD6)

val backgroundLight = Color(0xFFFEFBFF)
val onBackgroundLight = Color(0xFF1B1B1F)
val surfaceLight = Color(0xFFFEFBFF)
val onSurfaceLight = Color(0xFF1B1B1F)
val surfaceVariantLight = Color(0xFFE1E0F9)
val onSurfaceVariantLight = Color(0xFF45464F)
val outlineLight = Color(0xFF767680)
val outlineVariantLight = Color(0xFFC6C6D0)

val backgroundDark = Color(0xFF131318)
val onBackgroundDark = Color(0xFFE4E1E6)
val surfaceDark = Color(0xFF131318)
val onSurfaceDark = Color(0xFFE4E1E6)
val surfaceVariantDark = Color(0xFF45464F)
val onSurfaceVariantDark = Color(0xFFC6C6D0)
val outlineDark = Color(0xFF90909A)
val outlineVariantDark = Color(0xFF45464F)

val scrimLight = Color(0xFF000000)
val scrimDark = Color(0xFF000000)
val inverseSurfaceLight = Color(0xFF303034)
val inverseOnSurfaceLight = Color(0xFFF2F0F4)
val inversePrimaryLight = Color(0xFFBAC3FF)
val inverseSurfaceDark = Color(0xFFE4E1E6)
val inverseOnSurfaceDark = Color(0xFF303034)
val inversePrimaryDark = Color(0xFF3D5AFE)
