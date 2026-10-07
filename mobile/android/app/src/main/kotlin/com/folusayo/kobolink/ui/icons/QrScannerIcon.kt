package com.folusayo.kobolink.ui.icons

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * A solid-glyph "scan QR" mark on the 24dp Material grid: four hard-cornered
 * viewfinder brackets and a scan line. The extended Material icon set has a
 * `QrCodeScanner`, but that set is several megabytes of vectors for one
 * glyph, so this app draws the one it needs.
 */
val QrScannerIcon: ImageVector by lazy {
    ImageVector.Builder(
        name = "QrScanner",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        path(fill = SolidColor(Color.Black)) {
            // Top-left bracket
            moveTo(3f, 3f); horizontalLineTo(9f); verticalLineTo(5f); horizontalLineTo(5f); verticalLineTo(9f); horizontalLineTo(3f); close()
            // Top-right bracket
            moveTo(15f, 3f); horizontalLineTo(21f); verticalLineTo(9f); horizontalLineTo(19f); verticalLineTo(5f); horizontalLineTo(15f); close()
            // Bottom-left bracket
            moveTo(3f, 15f); horizontalLineTo(5f); verticalLineTo(19f); horizontalLineTo(9f); verticalLineTo(21f); horizontalLineTo(3f); close()
            // Bottom-right bracket
            moveTo(19f, 15f); horizontalLineTo(21f); verticalLineTo(21f); horizontalLineTo(15f); verticalLineTo(19f); horizontalLineTo(19f); close()
            // Scan line
            moveTo(7f, 11f); horizontalLineTo(17f); verticalLineTo(13f); horizontalLineTo(7f); close()
        }
    }.build()
}
