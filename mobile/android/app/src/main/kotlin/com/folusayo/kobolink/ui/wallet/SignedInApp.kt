package com.folusayo.kobolink.ui.wallet

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import com.folusayo.kobolink.auth.AuthenticatedUser
import com.folusayo.kobolink.wallet.WalletRoute
import com.folusayo.kobolink.wallet.WalletViewModel

/**
 * Everything a signed-in user sees: wallet home, send money, scan to pay.
 * Replaces the M2 proof-of-session screen. All state is in [viewModel], so
 * rotation and theme changes keep the form, the in-flight transfer and the
 * scroll-independent data.
 *
 * System Back is handled here and only here: from Send or Scan it goes to
 * the wallet home; from the home it falls through to the system.
 */
@Composable
fun SignedInApp(
    user: AuthenticatedUser,
    viewModel: WalletViewModel,
    onLogout: () -> Unit,
) {
    val route by viewModel.route.collectAsState()
    val home by viewModel.home.state.collectAsState()
    val send by viewModel.send.state.collectAsState()
    val cameraAsked by viewModel.cameraPermissionAsked.collectAsState()

    BackHandler(enabled = route != WalletRoute.Home) { viewModel.back() }

    when (route) {
        WalletRoute.Home -> WalletHomeScreen(
            user = user,
            state = home,
            onLoad = viewModel.home::refresh,
            onRefresh = viewModel.home::refresh,
            onLoadMore = viewModel.home::loadMore,
            onSend = { viewModel.openSend() },
            onScan = viewModel::openScan,
            onLogout = onLogout,
        )
        WalletRoute.Send -> SendMoneyScreen(
            state = send,
            balanceKobo = home.wallet?.balanceKobo,
            actions = SendActions(
                onEdit = viewModel.send::edit,
                onSubmit = viewModel.send::submit,
                onCancelConfirmation = viewModel.send::cancelConfirmation,
                onConfirm = viewModel.send::confirm,
                onTryAgain = viewModel.send::tryAgain,
                onEditAgain = viewModel.send::editAgain,
                onNewPayment = { viewModel.openSend() },
                onDone = viewModel::leaveToHome,
                onBack = { viewModel.back() },
            ),
        )
        WalletRoute.Scan -> ScanQrScreen(
            permissionAsked = cameraAsked,
            onPermissionAsked = viewModel::onCameraPermissionAsked,
            onPayee = { viewModel.openSend(it) },
            onEnterManually = { viewModel.openSend() },
            onBack = { viewModel.back() },
        )
    }
}
