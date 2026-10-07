package com.folusayo.kobolink.wallet

import androidx.lifecycle.ViewModel
import androidx.lifecycle.createSavedStateHandle
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
    pending: PendingAttemptStore = InMemoryPendingAttemptStore(),
) : ViewModel() {

    val home = WalletHome(gateway, viewModelScope)
    val send = SendFlow(
        gateway = gateway,
        scope = viewModelScope,
        newKey = newKey,
        store = pending,
        // The reply's balance can be older than what is held (a replay returns the
        // original), so a success always reads the balance again as well.
        onSent = { home.applyTransfer(it); home.refresh() },
        // "Not enough money" means the balance on screen was wrong: look again.
        onFailed = { if (it.kind == TransferFailureKind.InsufficientFunds) home.refresh() },
    )

    /** A payment whose outcome is not settled: the home screen flags it, and Send surfaces it before anything new. */
    val pendingAttempt: StateFlow<TransferAttempt?> = send.pending

    private val _route = MutableStateFlow(WalletRoute.Home)
    val route: StateFlow<WalletRoute> = _route

    private val _cameraPermissionAsked = MutableStateFlow(false)

    /** Whether the system camera prompt has been shown in this process; see [cameraAccess]. */
    val cameraPermissionAsked: StateFlow<Boolean> = _cameraPermissionAsked

    fun onCameraPermissionAsked() {
        _cameraPermissionAsked.value = true
    }

    /**
     * Open the send screen, optionally pre-filled from a scan. If an earlier
     * payment is unresolved, THAT is what the screen shows (its key and
     * request intact) and the scanned payee is not used: the person settles
     * the old payment first, then scans again.
     */
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
        // Starting a payment: the balance on screen should be the real one ("Send another" included).
        home.refresh()
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

    /**
     * Done / Back to wallet: reload the balance, since a transfer may have
     * changed it. An unresolved payment is kept, not cleared (see
     * [SendFlow.start]); the home screen flags it.
     */
    fun leaveToHome() {
        send.start()
        _route.value = WalletRoute.Home
        home.refresh()
    }

    /** "I checked, and it did not go through": the one explicit way to drop an unresolved payment. */
    fun discardUnresolvedPayment() {
        send.discardUnresolved()
    }

    /** Sign-out or session end: drop everything about the previous user. */
    fun onSignedOut() {
        home.clear()
        send.reset()
        _route.value = WalletRoute.Home
    }

    companion object {
        val Factory = viewModelFactory {
            initializer {
                WalletViewModel(
                    gateway = WalletRepository(ApiClientProvider.wallet, ApiClientProvider.json),
                    pending = SavedStatePendingAttemptStore(createSavedStateHandle()),
                )
            }
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
