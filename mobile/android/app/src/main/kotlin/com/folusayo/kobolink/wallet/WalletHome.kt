package com.folusayo.kobolink.wallet

import com.folusayo.kobolink.generated.api.models.TransferResponse
import com.folusayo.kobolink.generated.api.models.Wallet
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * What the wallet home shows. A failed refresh keeps whatever was loaded
 * before (with the failure beside it) rather than blanking the screen: a
 * balance from a minute ago, labelled, is more useful than an empty card.
 */
data class HomeState(
    val wallet: Wallet? = null,
    val walletError: String? = null,
    val items: List<WalletEntry> = emptyList(),
    val nextCursor: String? = null,
    val activityError: String? = null,
    val refreshing: Boolean = false,
    val loadingMore: Boolean = false,
    /** False until the first refresh finishes, so the screen can tell "loading" from "empty". */
    val loadedOnce: Boolean = false,
)

/**
 * The wallet home's data: the derived balance (`GET /api/wallet`, a sum of
 * ledger entries computed server-side, never cached here as truth) and the
 * activity list (`GET /api/wallet/transactions`, cursor-paged).
 */
class WalletHome(
    private val gateway: WalletGateway,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(HomeState())
    val state: StateFlow<HomeState> = _state

    // Bumped by clear() and applyTransfer() so a read that was already in
    // flight cannot land afterwards and overwrite newer truth: the previous
    // user's data after a sign-out, or a pre-transfer balance after a transfer.
    private var clears = 0
    private var transfers = 0

    fun refresh() {
        if (_state.value.refreshing) return
        _state.value = _state.value.copy(refreshing = true)
        val clearsAtStart = clears
        val transfersAtStart = transfers
        scope.launch {
            val wallet = async { gateway.wallet() }
            val page = async { gateway.transactions(cursor = null) }
            val walletResult = wallet.await()
            val pageResult = page.await()

            if (clears != clearsAtStart) return@launch
            if (transfers != transfersAtStart) {
                // A transfer landed while this read was in flight; its balance
                // is newer than anything in these results. Read again.
                _state.value = _state.value.copy(refreshing = false)
                refresh()
                return@launch
            }

            var next = _state.value.copy(refreshing = false, loadedOnce = true)
            next = walletResult.fold(
                onSuccess = { next.copy(wallet = it, walletError = null) },
                onFailure = { next.copy(walletError = it.message ?: "Couldn't load your wallet.") },
            )
            next = pageResult.fold(
                onSuccess = { next.copy(items = it.items, nextCursor = it.nextCursor, activityError = null) },
                onFailure = { next.copy(activityError = it.message ?: "Couldn't load your recent activity.") },
            )
            _state.value = next
        }
    }

    fun loadMore() {
        val current = _state.value
        val cursor = current.nextCursor ?: return
        if (current.loadingMore || current.refreshing) return
        _state.value = current.copy(loadingMore = true)
        val clearsAtStart = clears
        scope.launch {
            val result = gateway.transactions(cursor)
            if (clears != clearsAtStart) return@launch
            result.fold(
                onSuccess = { page ->
                    val seen = _state.value.items.mapTo(HashSet()) { it.postingId }
                    _state.value = _state.value.copy(
                        items = _state.value.items + page.items.filterNot { it.postingId in seen },
                        nextCursor = page.nextCursor,
                        activityError = null,
                        loadingMore = false,
                    )
                },
                onFailure = {
                    _state.value = _state.value.copy(
                        activityError = it.message ?: "Couldn't load more activity.",
                        loadingMore = false,
                    )
                },
            )
        }
    }

    /**
     * A transfer just succeeded: the server's reply carries the sender's
     * updated wallet and the posted transaction, so the home screen can show
     * both immediately instead of waiting for (or racing) a refetch.
     */
    fun applyTransfer(response: TransferResponse) {
        transfers += 1
        val current = _state.value
        // A replayed transfer (Try again after an unknown outcome) returns the
        // ORIGINAL reply, stamped when it was first posted; its balance can be
        // older than one already held. Never go backwards.
        val held = current.wallet
        val incoming = response.wallet
        val incomingIsCurrent = held == null || !incoming.asOf.isBefore(held.asOf)
        _state.value = current.copy(
            wallet = if (incomingIsCurrent) Wallet(incoming.accountId, Wallet.Currency.NGN, incoming.balanceKobo, incoming.asOf) else held,
            walletError = null,
            items = listOf(response.transaction) + current.items.filterNot { it.postingId == response.transaction.postingId },
        )
    }

    /** Sign-out or an expired session: nothing of the previous user may remain in memory for the next. */
    fun clear() {
        clears += 1
        _state.value = HomeState()
    }
}
