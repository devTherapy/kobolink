package com.folusayo.kobolink.ui.wallet

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.folusayo.kobolink.ui.icons.QrScannerIcon
import com.folusayo.kobolink.wallet.CameraAccess
import com.folusayo.kobolink.wallet.QrDecodeResult
import com.folusayo.kobolink.wallet.QrRejection
import com.folusayo.kobolink.wallet.ScannedPayee
import com.folusayo.kobolink.wallet.cameraAccess
import com.folusayo.kobolink.wallet.decodeQrPayload
import kotlinx.coroutines.delay

/**
 * Scan to pay. A Kobolink QR code resolves to a [ScannedPayee] and the person
 * lands on the send form with the recipient (and amount, if the code asks
 * for one) filled in — they still review and confirm; a scan never sends.
 *
 * The camera permission is requested here, when the person has asked to
 * scan, and every outcome has somewhere to go:
 * - granted: the live viewfinder;
 * - never asked: the system prompt appears on arrival;
 * - denied once: an explanation and a button to ask again;
 * - denied for good, or no camera at all: a button to Settings (or nothing
 *   to open) and, always, "Enter details instead" — the form needs no camera.
 *
 * [permissionAsked] and [onPermissionAsked] live in the caller's ViewModel
 * so leaving and re-entering this screen does not forget that the system
 * prompt has already been shown (see [cameraAccess]).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScanQrScreen(
    permissionAsked: Boolean,
    onPermissionAsked: () -> Unit,
    onPayee: (ScannedPayee) -> Unit,
    onEnterManually: () -> Unit,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var granted by remember { mutableStateOf(hasCameraPermission(context)) }
    var cameraBroken by remember { mutableStateOf(false) }
    var requestedThisVisit by remember { mutableStateOf(false) }

    // The person may grant (or revoke) the permission in Settings and come back.
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) granted = hasCameraPermission(context)
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { result ->
        granted = result
        onPermissionAsked()
    }

    val access = cameraAccess(
        granted = granted,
        askedBefore = permissionAsked,
        shouldShowRationale = context.findActivity()?.let {
            androidx.core.app.ActivityCompat.shouldShowRequestPermissionRationale(it, Manifest.permission.CAMERA)
        } ?: false,
    )

    LaunchedEffect(access) {
        if (access == CameraAccess.AskFirst && !requestedThisVisit) {
            requestedThisVisit = true
            launcher.launch(Manifest.permission.CAMERA)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Scan to pay") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { insets ->
        Box(modifier = Modifier.fillMaxSize().padding(insets)) {
            when {
                access == CameraAccess.Granted && !cameraBroken -> Viewfinder(
                    onPayee = onPayee,
                    onUnavailable = { cameraBroken = true },
                    onEnterManually = onEnterManually,
                )
                access == CameraAccess.Granted -> PermissionPanel(
                    title = "The camera isn't available",
                    body = "Another app may be using it, or this device has no camera. You can still pay by entering the recipient's number.",
                    primary = null,
                    onEnterManually = onEnterManually,
                )
                access == CameraAccess.AskFirst -> PermissionPanel(
                    title = "Allow camera to scan",
                    body = "Kobolink uses the camera only to read payment QR codes. Nothing is recorded or saved.",
                    primary = PanelAction("Allow camera", null) { launcher.launch(Manifest.permission.CAMERA) },
                    onEnterManually = onEnterManually,
                )
                access == CameraAccess.CanAskAgain -> PermissionPanel(
                    title = "Camera access is needed to scan",
                    body = "Kobolink uses the camera only to read payment QR codes. Nothing is recorded or saved. " +
                        "You can also skip the scan and enter the recipient's number.",
                    primary = PanelAction("Allow camera", null) { launcher.launch(Manifest.permission.CAMERA) },
                    onEnterManually = onEnterManually,
                )
                else -> PermissionPanel(
                    title = "Camera access is turned off",
                    body = "To scan, turn on Camera for Kobolink in your phone's Settings. " +
                        "Or enter the recipient's number instead; sending works the same.",
                    primary = PanelAction("Open settings", Icons.Filled.Settings) { context.openAppSettings() },
                    onEnterManually = onEnterManually,
                )
            }
        }
    }
}

private class PanelAction(
    val label: String,
    val icon: androidx.compose.ui.graphics.vector.ImageVector?,
    val onClick: () -> Unit,
)

@Composable
private fun PermissionPanel(
    title: String,
    body: String,
    primary: PanelAction?,
    onEnterManually: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Surface(
            shape = MaterialTheme.shapes.extraLarge,
            color = MaterialTheme.colorScheme.secondaryContainer,
            modifier = Modifier.size(72.dp),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(QrScannerIcon, contentDescription = null, tint = MaterialTheme.colorScheme.onSecondaryContainer)
            }
        }
        Text(
            text = title,
            style = MaterialTheme.typography.titleLarge,
            textAlign = TextAlign.Center,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
        Text(
            text = body,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        if (primary != null) {
            Button(
                onClick = primary.onClick,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp),
            ) {
                if (primary.icon != null) Icon(primary.icon, contentDescription = null, modifier = Modifier.padding(end = 8.dp))
                Text(primary.label)
            }
        }
        FilledTonalButton(
            onClick = onEnterManually,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp),
        ) { Text("Enter details instead") }
    }
}

@Composable
private fun Viewfinder(
    onPayee: (ScannedPayee) -> Unit,
    onUnavailable: () -> Unit,
    onEnterManually: () -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    var rejection by remember { mutableStateOf<QrRejection?>(null) }
    var handled by remember { mutableStateOf(false) }

    // The camera reports the same code on every frame; act on the first usable one only.
    fun onText(text: String) {
        if (handled) return
        when (val result = decodeQrPayload(text)) {
            is QrDecodeResult.Success -> {
                handled = true
                haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                onPayee(result.payee)
            }
            is QrDecodeResult.Rejected -> rejection = result.reason
        }
    }

    // A rejection stays up while the bad code is in view and clears itself shortly after.
    LaunchedEffect(rejection) {
        if (rejection != null) {
            delay(3_000)
            rejection = null
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        QrCameraPreview(
            onQrText = ::onText,
            onUnavailable = onUnavailable,
            modifier = Modifier
                .fillMaxSize()
                .semantics { contentDescription = "Camera viewfinder. Point it at a Kobolink payment QR code." },
        )

        // Targeting guide: a rounded square on the M3 extra-large (28dp) radius. The camera feed is not
        // themed, so the guide is plain white with a scrim behind the text, readable on any scene.
        Surface(
            shape = MaterialTheme.shapes.extraLarge,
            color = Color.Transparent,
            border = BorderStroke(3.dp, Color.White),
            modifier = Modifier
                .align(Alignment.Center)
                .size(240.dp),
        ) {}

        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            val shown = rejection
            if (shown != null) {
                Card(
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { liveRegion = LiveRegionMode.Assertive },
                ) {
                    Text(
                        text = shown.message,
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onErrorContainer,
                        modifier = Modifier.padding(16.dp),
                    )
                }
            }
            Surface(
                shape = MaterialTheme.shapes.large,
                color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        text = "Point the camera at a Kobolink QR code",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                        textAlign = TextAlign.Center,
                    )
                    TextButton(onClick = onEnterManually, modifier = Modifier.heightIn(min = 48.dp)) {
                        Icon(Icons.Filled.Info, contentDescription = null, modifier = Modifier.padding(end = 8.dp))
                        Text("Enter details instead")
                    }
                }
            }
        }
    }
}

private fun hasCameraPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

private fun Context.findActivity(): Activity? {
    var current: Context? = this
    while (current is ContextWrapper) {
        if (current is Activity) return current
        current = current.baseContext
    }
    return null
}

private fun Context.openAppSettings() {
    startActivity(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
}
