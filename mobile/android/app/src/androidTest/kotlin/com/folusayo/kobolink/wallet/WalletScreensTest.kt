package com.folusayo.kobolink.wallet

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.folusayo.kobolink.auth.AuthenticatedUser
import com.folusayo.kobolink.generated.api.models.Wallet
import com.folusayo.kobolink.ui.theme.KobolinkTheme
import com.folusayo.kobolink.ui.wallet.SendActions
import com.folusayo.kobolink.ui.wallet.SendMoneyScreen
import com.folusayo.kobolink.ui.wallet.WalletHomeScreen
import java.net.SocketTimeoutException
import java.time.OffsetDateTime
import org.junit.Rule
import org.junit.Test

/**
 * Instrumented UI checks for the M5 screens: what each outcome shows, that a
 * failed transfer always says whether money moved, that an unknown outcome
 * offers no way to edit and pay again, and that the controls hold at 200%
 * font scale.
 *
 * WRITTEN BUT NOT RUN. There is no emulator or device in the environment this
 * was written in, so this compiles (`compileDebugAndroidTestKotlin`) and that
 * is all that has been verified. Run it with `./gradlew connectedDebugAndroidTest`
 * on an emulator before relying on it.
 */
class WalletScreensTest {

    @get:Rule
    val compose = createComposeRule()

    private val attempt = TransferAttempt("key-0123456789abcdef", "+2348031234567", 250_000L, null, "Ada Obi")
    private val noopActions = SendActions({}, {}, {}, {}, {}, {}, {}, {}, {})

    private fun show(fontScale: Float = 1f, content: @Composable () -> Unit) {
        compose.setContent {
            val base = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(base.density, fontScale)) {
                KobolinkTheme { content() }
            }
        }
    }

    @Test
    fun formShowsFieldErrorsAfterAnAttemptToSend() {
        show {
            SendMoneyScreen(
                state = SendState(form = SendForm(phone = "123", amount = ""), showErrors = true),
                balanceKobo = null,
                actions = noopActions,
            )
        }
        compose.onNodeWithText("Enter a Nigerian mobile number, like 0803 123 4567.").assertIsDisplayed()
        compose.onNodeWithText("Enter an amount.").assertIsDisplayed()
    }

    @Test
    fun confirmationNamesTheAmountAndTheRecipient() {
        show {
            SendMoneyScreen(
                state = SendState(form = SendForm(phone = "08031234567", amount = "2500"), phase = SendPhase.Confirming(attempt)),
                balanceKobo = 1_000_000L,
                actions = noopActions,
            )
        }
        compose.onNodeWithText("Send ₦2,500?").assertIsDisplayed()
        compose.onNodeWithText("To Ada Obi").assertIsDisplayed()
    }

    @Test
    fun insufficientFundsSaysNoMoneyWasTakenAndOffersToEdit() {
        val failure = TransferFailure(TransferFailureKind.InsufficientFunds, MoneyMoved.No)
        show {
            SendMoneyScreen(
                state = SendState(phase = SendPhase.Failed(attempt, failure)),
                balanceKobo = 100_000L,
                actions = noopActions,
            )
        }
        compose.onNodeWithText("Not enough money in your wallet").assertIsDisplayed()
        compose.onNodeWithText("No money was taken. Your balance is unchanged.").assertIsDisplayed()
        compose.onNodeWithText("Edit details").assertIsDisplayed()
    }

    @Test
    fun anUnknownOutcomeSaysSoAndOffersNoEdit() {
        val failure = classifyTransferFailure(null, null, SocketTimeoutException())
        show {
            SendMoneyScreen(
                state = SendState(phase = SendPhase.Failed(attempt, failure)),
                balanceKobo = null,
                actions = noopActions,
            )
        }
        compose.onNodeWithText("Lost the connection while sending").assertIsDisplayed()
        compose.onNodeWithText("Try again").assertIsDisplayed()
        compose.onNodeWithText("Edit details").assertDoesNotExist()
    }

    @Test
    fun homeShowsTheDerivedBalanceAboveTheIntRange() {
        val wallet = Wallet("acc_1", Wallet.Currency.NGN, 3_000_000_000L, OffsetDateTime.now())
        show {
            WalletHomeScreen(
                user = AuthenticatedUser("u_1", "ada@example.com", "Ada"),
                state = HomeState(wallet = wallet, loadedOnce = true),
                onLoad = {}, onRefresh = {}, onLoadMore = {}, onSend = {}, onScan = {}, onLogout = {},
            )
        }
        compose.onNodeWithText("₦30,000,000").assertIsDisplayed()
    }

    @Test
    fun homeActionsStayReachableAndAtLeast48dpAtTwoTimesFontScale() {
        show(fontScale = 2f) {
            WalletHomeScreen(
                user = AuthenticatedUser("u_1", "ada@example.com", "Ada"),
                state = HomeState(loadedOnce = true),
                onLoad = {}, onRefresh = {}, onLoadMore = {}, onSend = {}, onScan = {}, onLogout = {},
            )
        }
        compose.onNodeWithText("Send money").assertIsDisplayed().assertHeightIsAtLeast(48.dp)
        compose.onNodeWithText("Scan to pay").assertIsDisplayed().assertHeightIsAtLeast(48.dp)
    }
}
