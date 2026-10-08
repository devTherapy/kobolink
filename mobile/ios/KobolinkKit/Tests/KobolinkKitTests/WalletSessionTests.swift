import Foundation
import Testing

@testable import KobolinkKit

/// Per-user state (lesson 7): the form, the balance, the saved payment. What a sign-out and a change of user
/// clear, what an involuntary session end leaves alone, and what a late reply may not do.
@MainActor
@Suite("Wallet: signing out and changing user")
struct WalletSessionTests {
    /// A signed-in user starts a payment whose outcome cannot be confirmed.
    private func unresolved(user: SignedInUser = WK.userOne, store: InMemoryPendingTransferStore = InMemoryPendingTransferStore()) async -> WalletRig {
        let rig = WalletRig(store: store, user: user)
        rig.service.queueTransfer(.failure(WK.offline))
        rig.startPayment(note: "Rent")
        _ = await waitUntil { rig.failure != nil }
        return rig
    }

    @Test("sign-out empties every typed field, the scanned name included, and the screens")
    func signOutEmptiesForm() {
        let rig = WalletRig()
        rig.wallet.openScan()
        rig.wallet.scan.onPayee?(ScannedPayee(toPhone: WK.phoneA, displayName: "Ada Obi", amountKobo: 250_000))
        rig.send.form.note = "Rent"
        rig.send.form.errors = [.amount: "x"]
        let before = rig.send.form.resetCount
        rig.wallet.sessionDidChange(.signedOutByChoice)

        let form = rig.send.form
        #expect(form.phone.isEmpty && form.amountText.isEmpty && form.note.isEmpty)
        #expect(form.scannedName == nil)
        #expect(form.errors.isEmpty)
        #expect(form.resetCount > before)
        #expect(rig.send.screen == .idle)
        #expect(!rig.wallet.isSendPresented)
    }

    @Test("sign-out empties the balance and the activity in memory")
    func signOutEmptiesHome() async {
        let rig = WalletRig()
        rig.service.queueWallet(.success(WK.balance()))
        rig.service.queueActivity(.success(ActivityPage(items: [WK.activity()], nextCursor: "c1")))
        await rig.home.refresh()
        #expect(rig.home.balance != nil && !rig.home.items.isEmpty)
        rig.wallet.sessionDidChange(.signedOutByChoice)
        #expect(rig.home.balance == nil)
        #expect(rig.home.items.isEmpty)
        #expect(rig.home.nextCursor == nil)
        #expect(!rig.home.hasLoaded)
    }

    @Test("a different user signing in empties everything of the previous one, even after an involuntary end")
    func userChange() async {
        let rig = WalletRig()
        rig.service.queueWallet(.success(WK.balance()))
        rig.service.queueActivity(.success(ActivityPage(items: [WK.activity()], nextCursor: nil)))
        await rig.home.refresh()
        rig.wallet.openSend()
        rig.fillForm(note: "private")
        rig.wallet.sessionDidChange(.ended)
        rig.wallet.sessionDidChange(.signedIn(WK.userTwo))
        #expect(rig.home.balance == nil && rig.home.items.isEmpty)
        #expect(rig.send.form.isEmpty)
        #expect(rig.send.screen == .idle)
    }

    @Test("sign-out writes what it owes BEFORE it removes anything, then removes the payment and takes the record back")
    func signOutRemoves() async {
        let rig = await unresolved()
        let key = rig.service.sends[0].key
        #expect(rig.wallet.hasSavedPayments)

        #expect(rig.wallet.prepareSignOut())
        #expect(rig.store.obligation == SignOutObligation(entries: [.init(code: WK.userOne.id, key: key)]))
        #expect(rig.store.snapshot.count == 1, "still there: nothing has been signed out yet")

        rig.wallet.sessionDidChange(.signedOutByChoice)
        #expect(rig.store.snapshot.isEmpty)
        #expect(rig.store.obligation == nil)
        #expect(rig.send.unresolved == nil)
        #expect(rig.send.screen == .idle)
    }

    @Test("if the obligation cannot be written, the sign-out is refused and nothing changes")
    func prepareRefused() async {
        let rig = await unresolved()
        rig.store.fail(.obligation)
        #expect(!rig.wallet.prepareSignOut())
        #expect(rig.store.snapshot.count == 1)
        #expect(rig.send.unresolved != nil)

        rig.store.heal()
        rig.store.fail(.list)
        #expect(!rig.wallet.prepareSignOut(), "if the payments cannot be listed, it cannot say what is owed")
    }

    @Test("with nothing saved, a sign-out owes nothing and writes nothing")
    func nothingOwed() {
        let rig = WalletRig()
        #expect(!rig.wallet.hasSavedPayments)
        #expect(rig.wallet.prepareSignOut())
        #expect(rig.store.obligation == nil)
    }

    @Test("a record this build cannot read counts as 'saved payments', so the sign-out asks")
    func unlistable() {
        let rig = WalletRig()
        rig.store.fail(.list)
        #expect(rig.wallet.hasSavedPayments)
    }

    @Test("sign-out is gated through the real session: if it cannot be made safe, the person stays signed in with the token")
    func gatedByTheSession() async throws {
        let rig = await unresolved()
        let checkout = CheckoutController(service: FakeCheckout(), store: InMemoryPendingCheckoutStore())
        let tokens = InMemoryTokenStore(token: Fixture.tokenA)
        let session = SessionController(auth: FakeAuth(), store: tokens, installMarker: InMemoryInstallMarker(isSet: true))
        await session.resolve()
        session.willSignOut = { SignOutGate.prepare(wallet: rig.wallet, checkout: checkout) }
        session.onChange = { rig.wallet.sessionDidChange($0); checkout.sessionDidChange($0) }

        rig.store.fail(.obligation)
        await session.signOut()
        #expect(session.signOutBlocked)
        #expect(session.state == .signedIn(Fixture.user))
        #expect(try tokens.readToken() == Fixture.tokenA)
        #expect(rig.store.snapshot.count == 1)

        rig.store.heal()
        await session.signOut()
        #expect(!session.signOutBlocked)
        #expect(session.state == .signedOut(.userRequested))
        #expect(try tokens.readToken() == nil)
        #expect(rig.store.snapshot.isEmpty)
    }

    @Test("if the checkout refuses, the wallet's record is taken back so a restart does not carry out a sign-out that never happened")
    func checkoutRefuses() async {
        let rig = await unresolved()
        let checkoutStore = InMemoryPendingCheckoutStore()
        let checkout = CheckoutController(service: FakeCheckout(), store: checkoutStore)
        checkoutStore.fail(.obligation)
        #expect(!SignOutGate.prepare(wallet: rig.wallet, checkout: checkout))
        #expect(rig.store.obligation == nil)
        #expect(rig.store.snapshot.count == 1)
        // A relaunch finds the payment, not a record that removes it.
        let again = rig.relaunched()
        guard case .failed(_, .interrupted) = again.send.screen else { Issue.record("\(again.send.screen)"); return }
    }

    @Test("the wallet's gate reports what is unfinished, wallet and checkout separately")
    func gateReports() async {
        let rig = await unresolved()
        let checkout = CheckoutController(service: FakeCheckout(), store: InMemoryPendingCheckoutStore())
        let report = SignOutGate.hasUnfinishedPayments(wallet: rig.wallet, checkout: checkout)
        #expect(report.wallet && !report.checkout)
        #expect(WalletCopy.signOutWarning(checkout: false, wallet: true) == WalletCopy.signOutWarningWallet)
        #expect(WalletCopy.signOutWarning(checkout: true, wallet: false) == CheckoutCopy.signOutWarning)
        #expect(WalletCopy.signOutWarning(checkout: true, wallet: true).hasPrefix("Payments on this iPhone were started and not finished."))
        #expect(WalletCopy.signOutWarningWallet.hasPrefix("A payment on this iPhone was started and not finished."))
    }

    // MARK: Late replies

    @Test("a reply that arrives after sign-out is dropped: no balance, no activity, no screen, and the payment does not come back")
    func lateReplyAfterSignOut() async {
        let rig = WalletRig()
        let gate = Gate()
        rig.service.queueTransfer(.success(WK.receipt(balanceKobo: 1_000)), gate: gate)
        rig.startPayment()
        #expect(await waitUntil { rig.service.sends.count == 1 })
        #expect(rig.wallet.prepareSignOut())
        rig.wallet.sessionDidChange(.signedOutByChoice)
        #expect(rig.store.snapshot.isEmpty)

        gate.open()
        await rig.settle()
        #expect(rig.send.screen == .idle)
        #expect(rig.home.balance == nil, "the previous user's balance is not written back")
        #expect(rig.home.items.isEmpty)
        #expect(rig.store.snapshot.isEmpty)
        #expect(rig.send.unresolved == nil)
    }

    @Test("a reply for the previous user, after a different user signed in, touches neither screen nor home; their record is cleaned up")
    func lateReplyAfterUserChange() async {
        let rig = WalletRig()
        let gate = Gate()
        rig.service.queueTransfer(.success(WK.receipt(balanceKobo: 1_000)), gate: gate)
        rig.startPayment()
        #expect(await waitUntil { rig.service.sends.count == 1 })
        rig.wallet.sessionDidChange(.ended)
        rig.wallet.sessionDidChange(.signedIn(WK.userTwo))
        #expect(rig.store.snapshot.count == 1, "the first user's payment is theirs: the next user does not delete it")
        gate.open()
        await rig.settle()
        #expect(rig.send.screen == .idle)
        #expect(rig.home.balance == nil && rig.home.items.isEmpty)
        #expect(rig.store.snapshot.isEmpty, "it posted, so its record is done")
    }

    @Test("an involuntary end while the request is in the air: the same user signing in finds the answer, not a stuck spinner")
    func endedWhileSending() async {
        let rig = WalletRig()
        let gate = Gate()
        rig.service.queueTransfer(.success(WK.receipt()), gate: gate)
        rig.startPayment()
        #expect(await waitUntil { rig.service.sends.count == 1 })
        rig.wallet.sessionDidChange(.ended)
        rig.wallet.sessionDidChange(.signedIn(WK.userOne))
        guard case .sending = rig.send.screen else { Issue.record("\(rig.send.screen)"); return }
        gate.open()
        #expect(await waitUntil { rig.isSent })
        #expect(rig.store.snapshot.isEmpty)
    }

    @Test("user A's request in the air, user B signs in and out of the picture, A is back: the answer lands for A, not a spinner")
    func backAfterSomeoneElse() async {
        let rig = WalletRig()
        let gate = Gate()
        rig.service.queueTransfer(.success(WK.receipt()), gate: gate)
        rig.startPayment()
        #expect(await waitUntil { rig.service.sends.count == 1 })
        rig.wallet.sessionDidChange(.ended)
        rig.wallet.sessionDidChange(.signedIn(WK.userTwo))
        #expect(rig.send.screen == .idle)
        rig.wallet.sessionDidChange(.signedIn(WK.userOne))
        guard case .sending = rig.send.screen else { Issue.record("\(rig.send.screen)"); return }
        gate.open()
        #expect(await waitUntil { rig.isSent })
        #expect(rig.store.snapshot.isEmpty)
    }

    // MARK: An involuntary end

    @Test("an involuntary end forgets nothing: the payment stays, and the same user signing in gets it back")
    func endedKeepsIt() async {
        let rig = await unresolved()
        let key = rig.service.sends[0].key
        rig.wallet.sessionDidChange(.ended)
        #expect(rig.store.snapshot.count == 1)
        #expect(rig.store.obligation == nil)
        #expect(!rig.wallet.isSendPresented)

        rig.wallet.sessionDidChange(.signedIn(WK.userOne))
        guard case .failed(let attempt, let failure) = rig.send.screen else { Issue.record("\(rig.send.screen)"); return }
        #expect(attempt.key == key)
        #expect(failure.money == .unknown)
        rig.service.queueTransfer(.success(WK.receipt(for: WK.instruction(note: "Rent"))))
        rig.send.tryAgain()
        #expect(await waitUntil { rig.isSent })
        #expect(rig.service.sends[1].key == key)
    }

    @Test("a 401 on the payment itself reads as 'signed out, unknown', and the payment is waiting after sign-in")
    func unauthenticatedPayment() async {
        let rig = WalletRig()
        rig.service.queueTransfer(.failure(WK.unauthenticated))
        rig.startPayment()
        #expect(await waitUntil { rig.failure != nil })
        #expect(rig.failure == .sessionEnded)
        rig.wallet.sessionDidChange(.ended)
        rig.wallet.sessionDidChange(.signedIn(WK.userOne))
        #expect(rig.send.unresolved != nil)
        #expect(rig.store.snapshot.count == 1)
    }

    @Test("another user's payment is never loaded, shown, or removed by someone else; it is there when they come back")
    func otherUsersPayment() async {
        let first = await unresolved()
        let key = first.service.sends[0].key
        first.wallet.sessionDidChange(.ended)

        let second = first.relaunched(user: WK.userTwo)
        #expect(second.send.screen == .idle)
        #expect(second.send.unresolved == nil)
        second.wallet.openSend()
        #expect(second.send.screen == .form)
        #expect(second.store.snapshot.count == 1)

        let back = second.relaunched(user: WK.userOne)
        guard case .failed(let attempt, .interrupted) = back.send.screen else { Issue.record("\(back.send.screen)"); return }
        #expect(attempt.key == key)
    }

    @Test("the next user to sign in after a sign-out has nothing to resend")
    func nothingToResend() async {
        let rig = await unresolved()
        #expect(rig.wallet.prepareSignOut())
        rig.wallet.sessionDidChange(.signedOutByChoice)
        rig.wallet.sessionDidChange(.signedIn(WK.userOne))
        #expect(rig.send.screen == .idle)
        rig.send.tryAgain()
        #expect(rig.service.sends.count == 1)
    }

    // MARK: A removal that fails

    @Test("a removal that fails leaves the obligation, and the payment is hidden from the next launch until it succeeds")
    func removalFails() async {
        let rig = await unresolved()
        #expect(rig.wallet.prepareSignOut())
        rig.store.fail(.remove)
        rig.wallet.sessionDidChange(.signedOutByChoice)
        #expect(rig.store.snapshot.count == 1)
        #expect(rig.store.obligation != nil)

        rig.store.heal()
        rig.store.fail(.remove)
        let again = rig.relaunched()
        guard case .blocked(.cannotClear) = again.send.screen else { Issue.record("\(again.send.screen)"); return }
        again.send.begin(scanning: false)
        #expect(again.send.screen != .form, "the form is not offered while an old payment cannot be cleared")

        again.store.heal()
        again.send.retryBlocked()
        #expect(again.send.screen == .idle)
        #expect(again.store.snapshot.isEmpty)
        #expect(again.store.obligation == nil)
    }

    @Test("an obligation this build cannot read blocks the wallet's payments, and the confirmed reset is the way out")
    func obligationUnreadable() async {
        let store = InMemoryPendingTransferStore()
        store.fail(.obligation, as: .undecodable)
        let rig = WalletRig(store: store)
        guard case .blocked(.obligationUnreadable) = rig.send.screen else { Issue.record("\(rig.send.screen)"); return }
        rig.wallet.openSend()
        #expect(rig.send.screen == .blocked(.obligationUnreadable))

        store.heal()
        store.fail(.remove)
        _ = try? store.save(WK.attempt())
        rig.send.forgetSavedPayments()
        #expect(rig.send.screen == .blocked(.resetFailed))
        #expect(store.snapshot.count == 1, "nothing changed")

        store.heal()
        rig.send.forgetSavedPayments()
        #expect(rig.send.screen == .idle)
        #expect(store.snapshot.isEmpty)
    }

    @Test("a Keychain that cannot be read blocks the form instead of guessing 'nothing is waiting'")
    func storageUnreadable() {
        let store = InMemoryPendingTransferStore()
        store.fail(.read)
        let rig = WalletRig(store: store)
        #expect(rig.send.screen == .blocked(.unreadable))
        rig.wallet.openSend()
        #expect(rig.send.screen == .blocked(.unreadable))
        #expect(rig.service.sends.isEmpty)
        store.heal()
        rig.wallet.openSend()
        #expect(rig.send.screen == .form)
    }

    @Test("a saved payment this build cannot read blocks, and forgetting it is confirmed")
    func undecodableSlot() {
        let store = InMemoryPendingTransferStore()
        store.plantUnreadable(userID: WK.userOne.id)
        let rig = WalletRig(store: store)
        #expect(rig.send.screen == .blocked(.undecodable))
        rig.send.forgetSavedPayments()
        #expect(rig.send.screen == .idle)
        rig.wallet.openSend()
        #expect(rig.send.screen == .form)
    }

    @Test("taking a prepared sign-out back restores the record to what it was")
    func cancelPrepared() async {
        let rig = await unresolved()
        #expect(rig.wallet.prepareSignOut())
        #expect(rig.store.obligation != nil)
        rig.wallet.cancelPreparedSignOut()
        #expect(rig.store.obligation == nil)
        #expect(rig.store.snapshot.count == 1)
    }
}
