import KobolinkKit
import SwiftUI

@main
struct KobolinkApp: App {
    private let home: RootView.Home

    init() {
        do {
            let configuration = try APIConfiguration()
            let tokenStore = KeychainTokenStore()
            let rejections = SessionRejectionRelay()
            let client = KobolinkAPIClient(
                configuration: configuration,
                middlewares: [
                    AuthMiddleware(baseURL: configuration.baseURL, tokenStore: tokenStore, relay: rejections)
                ]
            )
            let session = SessionController(
                auth: client,
                store: tokenStore,
                installMarker: UserDefaultsInstallMarker()
            )
            // A 401 to an authenticated request ends the session; see SessionController.tokenRejected.
            rejections.handler = { token in
                Task { @MainActor in session.tokenRejected(token) }
            }
            home = .ready(host: configuration.host, checker: ConnectionChecker(api: client), session: session)
        } catch {
            home = .misconfigured(error)
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView(home: home)
        }
    }
}
