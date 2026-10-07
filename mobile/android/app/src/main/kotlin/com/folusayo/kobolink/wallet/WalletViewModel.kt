package com.folusayo.kobolink.wallet

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.lifecycle.viewModelScope
import com.folusayo.kobolink.api.ApiClientProvider
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

enum class WalletRoute { Home, Send, Scan }

/**
 * Holds the wallet screens' state across rotation: the home data, the send
 * flow, and which of the three screens is showing. The logic is in
 * [WalletHome] and [SendFlow] (both JVM-tested); this class only gives them a
 * lifecycle-scoped coroutine scope and wires a successful transfer into the
 * home balance.
 *
 * Navigation is a three-value route, not a navigation library: Home, Send,
 * Scan. System Back is [back].
 */
class WalletViewModel(
    gateway: WalletGateway,
    newKey: () -> String = { UUID.randomUUID().toString() },
) : ViewModel() {

    val home = WalletHome(gateway, viewModelScope)
    val send = SendFlow(gateway, viewModelScope, newKey, onSent = home::applyTransfer)

    private val _route = MutableStateFlow(WalletRoute.Home)
    val route: StateFlow<WalletRoute> = _route

    private val _cameraPermissionAsked = MutableStateFlow(false)

    /** Whether the system camera prompt has been shown in this process; see [cameraAccess]. */
    val cameraPermissionAsked: StateFlow<Boolean> = _cameraPermissionAsked

    fun onCameraPermissionAsked() {
        _cameraPermissionAsked.value = true
    }

    fun openSend(payee: ScannedPayee? = null) {
        send.start(
            if (payee == null) {
                SendForm()
            } else {
                SendForm(
                    phone = payee.toPhone,
                    amount = payee.amountKobo?.let(::nairaFieldText).orEmpty(),
                    payeeName = payee.displayName,
                )
            },
        )
        _route.value = WalletRoute.Send
    }

    fun openScan() {
        _route.value = WalletRoute.Scan
    }

    /**
     * System Back. Returns true when it was handled here (every screen but
     * Home), false to let the system leave the app. While a transfer request
     * is in flight Back is absorbed: leaving would hide the one thing the
     * person is waiting to learn.
     */
    fun back(): Boolean {
        if (_route.value == WalletRoute.Home) return false
        if (send.state.value.phase is SendPhase.Sending) return true
        leaveToHome()
        return true
    }

    /** Done / Back to wallet: reload the balance, since a transfer may have changed it (or may have, if the outcome was unknown). */
    fun leaveToHome() {
        send.start()
        _route.value = WalletRoute.Home
        home.refresh()
    }

    /** Sign-out or session expiry: drop everything about the previous user. */
    fun onSignedOut() {
        home.clear()
        send.start()
        _route.value = WalletRoute.Home
    }

    companion object {
        val Factory = viewModelFactory {
            initializer { WalletViewModel(WalletRepository(ApiClientProvider.wallet, ApiClientProvider.json)) }
        }
    }
}

/**
 * A scanned amount, as the text an amount field shows (`1500.50`, `100`).
 * Goes through [com.folusayo.kobolink.money.Kobo] for the conversion, so no
 * division by 100 appears here.
 */
internal fun nairaFieldText(kobo: Long): String =
    com.folusayo.kobolink.money.Kobo.formatNaira(kobo).removePrefix("₦").replace(",", "")
