import KobolinkKit
import SwiftUI

/// The app's one navigation stack, and the single place deep links enter.
///
/// `kobolink://l/{code}` arrives through `onOpenURL`; a universal link
/// (`https://pay.folusayo.com/l/{code}`, once the Associated Domains entitlement
/// exists) arrives through `onContinueUserActivity` and, on current iOS, `onOpenURL` too.
/// Both feed `DeepLinkNavigator`, which makes a repeat harmless. The handlers sit on the
/// stack, outside the home screen, so a link works the same whether the app was launched
/// by it (cold start) or was already running (warm start), and whether or not the
/// server address is configured.
///
/// The screen under the stack is the session's (sign-in, signed-in home, and so on), and a link is
/// pushed over it. So a link wins the route in every session state, including signed out and
/// resolving: a payer never meets the merchant login on the way to a payment link, and Back from the
/// link lands on whatever the session calls for.
struct RootView: View {
    let home: Home

    enum Home {
        case ready(
            host: String, checker: ConnectionChecker, session: SessionController, checkout: CheckoutController,
            wallet: WalletController)
        case misconfigured(APIConfiguration.Problem)
    }

    @State private var navigator = DeepLinkNavigator()
    /// The code of the open link, saved with the scene so a relaunch can restore it.
    @SceneStorage("openLinkCode") private var openLinkCode: String?

    var body: some View {
        NavigationStack(path: $navigator.path) {
            homeScreen
                .navigationDestination(for: LinkDestination.self) { destination in
                    LinkLandingView(destination: destination, home: home, onDone: { navigator.path = [] })
                }
        }
        .onOpenURL { navigator.open($0) }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            if let url = activity.webpageURL { navigator.open(url) }
        }
        .fullScreenCover(item: $navigator.external) { link in
            SafariView(url: link.url, onFinish: { navigator.closeExternal() }).ignoresSafeArea()
        }
        .onChange(of: navigator.path) {
            openLinkCode = navigator.path.first?.code?.value
            followPath()
        }
        .task {
            navigator.restore(openLinkCode.flatMap(LinkCode.init))
        }
    }

    /// The checkout follows the stack's one link: open it when it arrives (cold start, warm start, a second
    /// link replacing the first), close it when Back or Done takes it away, so a form never outlives its screen.
    private func followPath() {
        guard case .ready(_, _, _, let checkout, let wallet) = home else { return }
        if let code = navigator.path.first?.code {
            // A link wins the screen: a sheet left up would sit on top of it.
            wallet.isSendPresented = false
            checkout.open(code)
        } else {
            checkout.close()
        }
    }

    @ViewBuilder private var homeScreen: some View {
        switch home {
        case .ready(let host, let checker, let session, let checkout, let wallet):
            SessionScreen(session: session, host: host, checker: checker, checkout: checkout, wallet: wallet)
        case .misconfigured(let problem):
            MisconfiguredView(problem: problem)
        }
    }
}
