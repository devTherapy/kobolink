package com.folusayo.kobolink.wallet

/**
 * Where the camera permission stands, as the scan screen needs to present it.
 * Pure so the decision is a JVM test; the Android calls that feed it
 * (`checkSelfPermission`, `shouldShowRequestPermissionRationale`) live in the
 * composable.
 */
enum class CameraAccess {
    /** The camera can be opened. */
    Granted,

    /** Never asked: ask on arrival, because the person tapped "Scan" to use it. */
    AskFirst,

    /** Denied once; the system will still show its prompt if asked again. Explain, then offer to ask again. */
    CanAskAgain,

    /** Denied for good ("Don't allow" twice, or "Don't ask again"). Only system Settings can change it. */
    Blocked,
}

/**
 * [askedBefore] must outlive the composable (the screen is left and
 * re-entered): without it a never-asked permission and a permanently denied
 * one look identical (both report "no rationale"), and the person would be
 * sent to Settings before they were ever asked.
 */
fun cameraAccess(granted: Boolean, askedBefore: Boolean, shouldShowRationale: Boolean): CameraAccess = when {
    granted -> CameraAccess.Granted
    !askedBefore -> CameraAccess.AskFirst
    shouldShowRationale -> CameraAccess.CanAskAgain
    else -> CameraAccess.Blocked
}
