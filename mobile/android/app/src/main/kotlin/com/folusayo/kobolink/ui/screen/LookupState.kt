package com.folusayo.kobolink.ui.screen

import com.folusayo.kobolink.generated.api.models.PublicLinkResponse
import kotlinx.serialization.json.Json

/**
 * What [LinkLookupScreen] is showing for the link code in its field.
 *
 * This file is deliberately free of Compose and Android types so the two
 * decisions a configuration change forces — "what survives the Activity being
 * recreated" and "must I hit the network again" — are plain functions a JVM
 * unit test can exercise. Rotation itself needs a device/emulator to observe;
 * these functions are the logic that decides its outcome.
 */
internal sealed interface LookupState {
    data object Idle : LookupState
    data object Loading : LookupState
    data class Resolved(val response: PublicLinkResponse) : LookupState
    data class Failed(val message: String) : LookupState
}

internal const val SAVED_IDLE = "idle"
internal const val SAVED_RESOLVED = "resolved"
internal const val SAVED_FAILED = "failed"

/**
 * Flattens a [LookupState] to a list of strings a `Bundle` can hold.
 *
 * [LookupState.Loading] is saved as "not yet fetched" ([LookupState.Idle]),
 * never as itself: the coroutine that would have completed it was cancelled
 * with the old Activity, so restoring `Loading` would leave a spinner that
 * can never finish.
 */
internal fun LookupState.toSaved(json: Json): List<String?> = when (this) {
    is LookupState.Idle, is LookupState.Loading -> listOf(SAVED_IDLE, null)
    is LookupState.Resolved -> listOf(SAVED_RESOLVED, json.encodeToString(PublicLinkResponse.serializer(), response))
    is LookupState.Failed -> listOf(SAVED_FAILED, message)
}

/**
 * Inverse of [toSaved]. Anything unrecognised or undecodable degrades to
 * [LookupState.Idle] (a fresh lookup) rather than crashing on restore.
 */
internal fun restoreLookupState(saved: List<String?>, json: Json): LookupState {
    val type = saved.getOrNull(0)
    val payload = saved.getOrNull(1)
    return when (type) {
        SAVED_RESOLVED -> payload
            ?.let { runCatching { json.decodeFromString(PublicLinkResponse.serializer(), it) }.getOrNull() }
            ?.let { LookupState.Resolved(it) }
            ?: LookupState.Idle
        SAVED_FAILED -> LookupState.Failed(payload ?: "Something went wrong.")
        else -> LookupState.Idle
    }
}

/**
 * Whether the deep-link auto-lookup should fire for [initialCode].
 *
 * [handledCode] is the deep-link code whose lookup already reached a terminal
 * result (resolved or failed), and is itself saved across recreation. A
 * recreated screen therefore does not re-fetch a code it already has an
 * answer for, and does not clobber a result the user got by typing a
 * different code by hand. A lookup that was still in flight when the Activity
 * died never recorded itself as handled, so it runs again — once, because the
 * old request died with the old Activity.
 */
internal fun shouldAutoLookUp(initialCode: String?, handledCode: String?): Boolean =
    initialCode != null && initialCode != handledCode
