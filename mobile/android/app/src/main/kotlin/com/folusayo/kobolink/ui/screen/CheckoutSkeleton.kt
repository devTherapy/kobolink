package com.folusayo.kobolink.ui.screen

import android.provider.Settings
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The loading state: the checkout's own layout drawn in placeholder blocks (merchant row, title, description,
 * amount card, two fields, the Pay button), never a centred spinner, so what arrives replaces what was
 * already there instead of rearranging it (docs/DESIGN-SPEC.md, "Loading is a skeleton in the shape of the
 * content").
 *
 * Text-line blocks are sized in `sp` and converted, so at a 2.0 font scale they grow with the text that is
 * about to replace them. The pulse is a calm alpha fade, not a travelling shimmer, and is switched off when
 * the system's animation scale is 0 ("Remove animations").
 *
 * The whole thing is one accessibility node, "Loading payment link", announced politely; the blocks
 * themselves say nothing.
 */
@Composable
fun CheckoutSkeleton() {
    val pulse = rememberPulse()
    Column(
        verticalArrangement = Arrangement.spacedBy(16.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clearAndSetSemantics {
                contentDescription = "Loading payment link"
                liveRegion = LiveRegionMode.Polite
            },
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Block(pulse, Modifier.size(40.dp), CircleShape)
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                TextBlock(pulse, 12.sp, width = 32.dp)
                TextBlock(pulse, 16.sp, width = 160.dp)
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            TextBlock(pulse, 24.sp, width = 260.dp)
            TextBlock(pulse, 16.sp, widthFraction = 1f)
            TextBlock(pulse, 16.sp, width = 200.dp)
        }
        Block(pulse, Modifier.fillMaxWidth().height(96.dp), MaterialTheme.shapes.medium)
        FieldOutline(pulse)
        FieldOutline(pulse)
        Block(pulse, Modifier.fillMaxWidth().height(56.dp), CircleShape)
    }
}

@Composable
private fun TextBlock(pulse: State<Float>, size: TextUnit, width: Dp? = null, widthFraction: Float? = null) {
    val height = with(LocalDensity.current) { size.toDp() }
    val sized = if (width != null) Modifier.size(width, height) else Modifier.fillMaxWidth(widthFraction ?: 1f).height(height)
    Block(pulse, sized, MaterialTheme.shapes.extraSmall)
}

/** An outlined field's outline with nothing in it: the shape the real field will take. */
@Composable
private fun FieldOutline(pulse: State<Float>) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .alpha(pulse.value)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, MaterialTheme.shapes.extraSmall),
    )
}

@Composable
private fun Block(pulse: State<Float>, modifier: Modifier, shape: androidx.compose.ui.graphics.Shape) {
    Box(
        modifier = modifier
            .alpha(pulse.value)
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceContainerHighest),
    )
}

@Composable
private fun rememberPulse(): State<Float> {
    val context = LocalContext.current
    val animationsOn = remember(context) {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f
    }
    if (!animationsOn) return remember { mutableFloatStateOf(1f) }
    return rememberInfiniteTransition(label = "skeleton").animateFloat(
        initialValue = 0.55f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(durationMillis = 900), RepeatMode.Reverse),
        label = "skeleton-pulse",
    )
}
