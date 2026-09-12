package com.folusayo.kobolink.ui.theme

import androidx.compose.material3.Typography

/**
 * The M3 type scale (Display/Headline/Title/Body/Label, large/medium/small)
 * with no overrides: Compose's default `Typography()` already renders every
 * role in Roboto — the Android system face — at the spec sizes and weights.
 * A future pass can thread a brand display face through the Display/Headline
 * roles without touching Body/Label, which is exactly what a type-role
 * system is for.
 */
val KobolinkTypography = Typography()
