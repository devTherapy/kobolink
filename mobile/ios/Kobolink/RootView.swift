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
struct RootView: View {
    let home: Home

    enum Home {
        case connection(host: String, checker: ConnectionChecker)
        case misconfigured(APIConfiguration.Problem)
    }

    @State private var navigator = DeepLinkNavigator()
    /// The code of the open link, saved with the scene so a relaunch can restore it.
    @SceneStorage("openLinkCode") private var openLinkCode: String?

    var body: some View {
        NavigationStack(path: $navigator.path) {
            homeScreen
                .navigationDestination(for: LinkDestination.self) { destination in
                    LinkLandingView(destination: destination)
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
        }
        .task {
            navigator.restore(openLinkCode.flatMap(LinkCode.init))
        }
    }

    @ViewBuilder private var homeScreen: some View {
        switch home {
        case .connection(let host, let checker):
            ConnectionView(host: host, checker: checker)
        case .misconfigured(let problem):
            MisconfiguredView(problem: problem)
        }
    }
}
