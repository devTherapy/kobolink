package com.folusayo.kobolink.auth

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * How [AuthInterceptor] (on an OkHttp thread, with no UI) tells the session
 * layer that the server rejected the stored token mid-session.
 */
class SessionExpiryBus {
    private val _events = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val events: SharedFlow<Unit> = _events.asSharedFlow()

    fun notifyExpired() {
        _events.tryEmit(Unit)
    }
}
