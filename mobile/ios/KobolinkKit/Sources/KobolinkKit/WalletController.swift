import Foundation
import Observation

/// The wallet as a whole: the home, the send flow, the camera, and whether the send sheet is up. It is the one
/// object the session talks to, and it wires the parts together so none of them knows about the others:
/// a posted transfer updates the home, a refusal for too little money refreshes it, a scanned code fills the form.
///
/// One instance lives for the app. The wallet exists only for a signed-in user; everything of that user's in
/// memory is emptied on a sign-out and on a different user (`sessionDidChange`), and an involuntary session end
/// forgets nothing but closes the sheet.
@MainActor
@Observable
public final class WalletController {
    public let home: WalletHomeController
    public let send: SendController
    public let scan: ScanController
    /// Whether the send sheet (form, review, progress, result, camera) is up. Bound to the sheet by the view.
    public var isSendPresented = false

    @ObservationIgnored private var userID: String?

    public init(
        service: any WalletServing,
        store: any PendingTransferStore,
        camera: any CameraAccess,
        makeKey: @escaping @Sendable () -> String = IdempotencyKey.make,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        home = WalletHomeController(service: service)
        send = SendController(service: service, store: store, makeKey: makeKey, now: now)
        scan = ScanController(camera: camera)

        let home = self.home
        send.onReceipt = { receipt, replayed in
            home.apply(receipt, replayed: replayed)
            // A replay's reply is the stored original and its balance can be old; either way the real one is a
            // read away.
            home.refreshSoon()
        }
        send.onInsufficientFunds = { home.refreshSoon() }
        let send = self.send
        scan.onPayee = { payee in send.useScanned(payee) }
    }

    // MARK: - Opening

    /// "Send Money". If an earlier payment is unresolved, THAT is what opens.
    public func openSend() {
        send.begin(scanning: false)
        present()
    }

    /// "Scan to Pay". If an earlier payment is unresolved, THAT is what opens, and the camera does not.
    public func openScan() {
        send.begin(scanning: true)
        if case .scan = send.screen { scan.prepare() }
        present()
    }

    /// The form's "Scan QR Code".
    public func startScanning() {
        send.startScanning()
        if case .scan = send.screen { scan.prepare() }
    }

    private func present() {
        guard send.screen != .idle else { return }
        // Starting a payment: the balance on screen should be the real one.
        home.refreshSoon()
        isSendPresented = true
    }

    /// The sheet went away, by a swipe or by its close button.
    public func sheetDidDismiss() {
        isSendPresented = false
        send.sheetClosed()
    }

    // MARK: - The session

    /// Whether an unfinished payment is saved on this device, for the sign-out confirmation.
    public var hasSavedPayments: Bool { send.hasSavedPayments }

    public func prepareSignOut() -> Bool { send.prepareSignOut() }
    public func cancelPreparedSignOut() { send.cancelPreparedSignOut() }

    /// React to a change in who is signed in.
    public func sessionDidChange(_ change: SessionChange) {
        switch change {
        case .ended:
            // Nothing is forgotten, so the same user signing in again finds the payment and the form as they left
            // them. The sheet closes: it belongs to a session that is gone.
            isSendPresented = false

        case .signedOutByChoice:
            userID = nil
            isSendPresented = false
            home.reset()
            scan.prepare()

        case .resolved(let user), .signedIn(let user):
            if let current = userID, current != user.id {
                isSendPresented = false
                home.reset()
            }
            userID = user.id
        }
        send.sessionDidChange(change)
    }
}

/// The two things that must be made safe before a sign-out: the wallet's saved payments and the checkout's. If
/// either cannot be, the sign-out does not happen.
@MainActor
public enum SignOutGate {
    /// The wallet goes first, and is taken back if the checkout then refuses: a sign-out that does not happen must
    /// not leave a record that makes the next launch carry it out.
    public static func prepare(wallet: WalletController, checkout: CheckoutController) -> Bool {
        guard wallet.prepareSignOut() else { return false }
        guard checkout.prepareSignOut() else {
            wallet.cancelPreparedSignOut()
            return false
        }
        return true
    }

    /// Any payment started on this iPhone and not finished, wallet or checkout.
    public static func hasUnfinishedPayments(wallet: WalletController, checkout: CheckoutController) -> (checkout: Bool, wallet: Bool) {
        (checkout.hasSessionAttempts, wallet.hasSavedPayments)
    }
}
