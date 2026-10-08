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
            // A payer's checkout. Attempts are remembered in the Keychain and owned by the session that made
            // them; the session tells the checkout when a person signs out or a different one signs in.
            let checkout = CheckoutController(
                service: client,
                store: KeychainPendingCheckoutStore(),
                ownerNow: { session.attemptOwner }
            )
            // The wallet: balance, activity and sending money, for the signed-in user. A transfer is remembered in the
            // Keychain, in the user's own slot, BEFORE its request leaves; the session tells the wallet when a person
            // signs out or a different one signs in, exactly as it tells the checkout.
            let wallet = WalletController(
                service: client,
                store: KeychainPendingTransferStore(),
                camera: SystemCameraAccess()
            )
            session.onChange = {
                checkout.sessionDidChange($0)
                wallet.sessionDidChange($0)
            }
            // A sign-out is refused unless BOTH can write down what it owes the device first.
            session.willSignOut = { SignOutGate.prepare(wallet: wallet, checkout: checkout) }
            home = .ready(
                host: configuration.host, checker: ConnectionChecker(api: client), session: session, checkout: checkout,
                wallet: wallet)
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
