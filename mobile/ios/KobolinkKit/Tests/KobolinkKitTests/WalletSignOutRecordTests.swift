import Foundation
import Testing

@testable import KobolinkKit

// Review round 1 of I5 (the M5 theme again: a payment of unknown outcome must not be lost without evidence).
//
// The wallet writes down what a sign-out owes BEFORE the session changes. Two things went wrong:
//   1. A record can outlive a sign-out that never happened (the checkout refused it and the take-back failed, or the
//      process died between the record and the token). The next launch carried it out and deleted the still
//      signed-in person's unknown payment, and the empty form minted a new key.
//   2. The record and the warning covered EVERY user's slot on the device, so B signing out or resetting removed
//      A's payment.
// The rules these tests pin: a record names its user; it is carried out only for a user who is NOT the confirmed
// signed-in one; and a sign-out or a reset touches only the signing-out user's own slots (and unreadable ones, whose
// owner nothing can say).

@MainActor
@Suite("Wallet: a sign-out record is evidence of a sign-out only when that user is gone")
struct WalletSignOutRecordTests {
    private func unresolved(user: SignedInUser = WK.userOne, store: InMemoryPendingTransferStore = InMemoryPendingTransferStore()) async -> WalletRig {
        let rig = WalletRig(store: store, user: user)
        rig.service.queueTransfer(.failure(WK.offline))
        rig.startPayment(note: "Rent")
        _ = await waitUntil { rig.failure != nil }
        return rig
    }

    private func expectKept(_ rig: WalletRig, key: String, sourceLocation: SourceLocation = #_sourceLocation) {
        // `.interrupted` after a relaunch; the failure it already showed while the app kept running.
        guard case .failed(let attempt, let failure) = rig.send.screen, !failure.isSettled else {
            Issue.record("\(rig.send.screen)", sourceLocation: sourceLocation)
            return
        }
        #expect(attempt.key == key, sourceLocation: sourceLocation)
        #expect(rig.send.unresolved?.key == key, sourceLocation: sourceLocation)
        #expect(rig.store.snapshot.map(\.key) == [key], "the saved payment is still on the device", sourceLocation: sourceLocation)
    }

    private func expectTryAgainReusesKey(_ rig: WalletRig, key: String, sourceLocation: SourceLocation = #_sourceLocation) async {
        rig.service.queueTransfer(.success(WK.receipt(for: WK.instruction(note: "Rent"))))
        rig.send.tryAgain()
        #expect(await waitUntil { rig.isSent }, sourceLocation: sourceLocation)
        #expect(rig.service.sends.last?.key == key, "the SAME key: a new one would pay twice", sourceLocation: sourceLocation)
        #expect(rig.keys.made == 0, "no key was minted after the relaunch", sourceLocation: sourceLocation)
    }

    // MARK: 2. A record for a sign-out that did not happen

    @Test("the checkout refuses, the wallet cannot take its record back, the app is relaunched with the same user: the payment is kept, with its key")
    func takeBackFailsThenRelaunch() async {
        let rig = await unresolved()
        let key = rig.service.sends[0].key
        let checkoutStore = InMemoryPendingCheckoutStore()
        let checkout = CheckoutController(service: FakeCheckout(), store: checkoutStore)
        checkoutStore.fail(.obligation)

        // The wallet writes its record; the checkout refuses; the take-back finds the Keychain unwilling.
        rig.store.heal()
        #expect(rig.wallet.prepareSignOut())
        #expect(rig.store.obligation != nil)
        rig.store.fail(.obligation)
        #expect(!checkout.prepareSignOut())
        rig.wallet.cancelPreparedSignOut()
        rig.store.heal()
        #expect(rig.store.obligation != nil, "the take-back failed: the record is still in the Keychain")
        expectKept(rig, key: key)

        // The person is still signed in. The next launch resolves the same user: the record describes a sign-out that
        // never happened, so it is dropped and the payment stays.
        let again = rig.relaunched()
        expectKept(again, key: key)
        #expect(again.store.obligation == nil, "the stale record is taken back, not carried out")
        await expectTryAgainReusesKey(again, key: key)
    }

    @Test("the process dies between the wallet's record and the token being cleared: the same user resolved again keeps the payment")
    func crashWindow() async {
        let rig = await unresolved()
        let key = rig.service.sends[0].key
        #expect(rig.wallet.prepareSignOut())
        #expect(rig.store.obligation != nil)
        // ...and nothing else ever happens: no cancel, no signed-out event.

        let again = rig.relaunched()
        expectKept(again, key: key)
        #expect(again.store.obligation == nil)
        again.wallet.openSend()
        guard case .failed(let shown, .interrupted) = again.send.screen else { Issue.record("\(again.send.screen)"); return }
        #expect(shown.key == key, "Send opens the unfinished payment, not an empty form")
        await expectTryAgainReusesKey(again, key: key)
    }

    @Test("the same user signing in afresh does not lose the payment either")
    func signedInAfresh() async {
        let rig = await unresolved()
        let key = rig.service.sends[0].key
        #expect(rig.wallet.prepareSignOut())
        rig.wallet.sessionDidChange(.ended)
        let again = rig.relaunched(user: nil)
        again.wallet.sessionDidChange(.signedIn(WK.userOne))
        expectKept(again, key: key)
    }

    @Test("a different user signing in carries the record out: the sign-out did happen for the person it names")
    func otherUserCarriesItOut() async {
        let rig = await unresolved()
        #expect(rig.wallet.prepareSignOut())
        let other = rig.relaunched(user: WK.userTwo)
        #expect(other.store.snapshot.isEmpty, "user one's payment was owed a removal and the removal ran")
        #expect(other.store.obligation == nil)
        #expect(other.send.screen == .idle)
    }

    @Test("a failed take-back keeps the payment on screen in the running app, and the next restore does not carry it out")
    func takeBackFailsInProcess() async {
        let rig = await unresolved()
        let key = rig.service.sends[0].key
        #expect(rig.wallet.prepareSignOut())
        rig.store.fail(.obligation)
        rig.wallet.cancelPreparedSignOut()
        // Still signed in: the payment is on the home, nothing is hidden, and Send opens it.
        #expect(rig.send.unresolved?.key == key)
        rig.store.heal()
        rig.wallet.sessionDidChange(.resolved(WK.userOne))
        expectKept(rig, key: key)
        #expect(rig.store.obligation == nil, "the take-back is retried until storage lets it through")
    }

    @Test("the app knows the sign-out did not happen even when storage would not take the record back: a 401 and another user signing in do not carry it out")
    func takeBackFailsThenSomeoneElse() async {
        let rig = await unresolved()
        let key = rig.service.sends[0].key
        #expect(rig.wallet.prepareSignOut())
        rig.store.fail(.obligation)
        rig.wallet.cancelPreparedSignOut()
        rig.store.heal()
        rig.wallet.sessionDidChange(.ended)
        rig.wallet.sessionDidChange(.signedIn(WK.userTwo))
        #expect(rig.store.snapshot.map(\.key) == [key], "user one never signed out: their payment is not removed")
        #expect(rig.store.obligation == nil, "the stale record is written away on the way")

        rig.wallet.sessionDidChange(.ended)
        rig.wallet.sessionDidChange(.signedIn(WK.userOne))
        expectKept(rig, key: key)
        rig.service.queueTransfer(.success(WK.receipt(for: WK.instruction(note: "Rent"))))
        rig.send.tryAgain()
        #expect(await waitUntil { rig.isSent })
        #expect(rig.service.sends.last?.key == key)
        #expect(rig.keys.made == 1, "only the key made for the first send")
    }

    @Test("a stale record that cannot be taken back at launch is never silent and never carried out: the payment is shown, and the write is retried")
    func takeBackAtLaunchFails() async {
        let rig = await unresolved()
        let key = rig.service.sends[0].key
        #expect(rig.wallet.prepareSignOut())

        rig.store.failObligationWrites()
        let again = rig.relaunched()
        expectKept(again, key: key)
        #expect(again.store.obligation != nil, "the Keychain would not let the record go")
        #expect(again.send.unresolved != nil, "the home still shows the unfinished payment")

        // The Keychain recovers. Opening Send (or any later restore) writes the take-back; nothing was ever removed.
        again.store.heal()
        again.wallet.openSend()
        #expect(again.store.obligation == nil)
        guard case .failed(let shown, .interrupted) = again.send.screen else { Issue.record("\(again.send.screen)"); return }
        #expect(shown.key == key)
        #expect(again.store.snapshot.map(\.key) == [key])
    }

    @Test("a record that names someone else too keeps their entry when this user's is dropped")
    func dropsOnlyTheConfirmedUsersEntry() async {
        let store = InMemoryPendingTransferStore()
        let a = WK.attempt(key: "11111111-1111-4111-8111-000000000001", user: WK.userOne)
        let b = WK.attempt(key: "22222222-2222-4222-8222-000000000002", user: WK.userTwo)
        try? store.save(a)
        try? store.save(b)
        try? store.saveObligation(SignOutObligation(entries: [.init(code: a.userID, key: a.key), .init(code: b.userID, key: b.key)]))

        let rig = WalletRig(store: store, user: WK.userOne)
        // Kept: user one's. Gone: user two's, whose entry was carried out because they are not the confirmed user.
        expectKept(rig, key: a.key)
        #expect(store.obligation == nil)
    }

    // MARK: 3. One user's sign-out and reset touch only that user's own slots

    @Test("A's unknown payment survives A's session ending, B signing in, B signing out and B forgetting; A comes back to the same key")
    func otherUsersPaymentSurvivesSignOutAndReset() async {
        let a = await unresolved()
        let key = a.service.sends[0].key
        a.wallet.sessionDidChange(.ended)

        // B signs in on the same phone and has a payment of their own that cannot be read.
        a.store.plantUnreadable(userID: WK.userTwo.id)
        let b = a.relaunched(user: WK.userTwo)
        #expect(b.send.screen == .blocked(.undecodable))
        #expect(b.wallet.hasSavedPayments, "B has a payment of their own that this build cannot read")

        // B forgets it: only B's slot goes.
        b.send.forgetSavedPayments()
        #expect(b.send.screen == .idle)
        #expect(b.store.snapshot.map(\.key) == [key], "A's payment is not B's to forget")

        // B signs out with nothing of their own: nothing is owed, and A's payment is not on B's warning.
        #expect(!b.wallet.hasSavedPayments, "B's sign-out warning is about B's payments, and B has none")
        #expect(b.wallet.prepareSignOut())
        #expect(b.store.obligation == nil)
        b.wallet.sessionDidChange(.signedOutByChoice)
        #expect(b.store.snapshot.map(\.key) == [key])

        // A signs back in: no banner lost, no empty form, the same key.
        let back = b.relaunched(user: WK.userOne)
        expectKept(back, key: key)
        await expectTryAgainReusesKey(back, key: key)
    }

    @Test("B's own unknown payment is what B's sign-out warns about and removes; A's stays")
    func signOutRemovesOnlyTheSigningOutUsersSlot() async {
        let a = await unresolved()
        let keyA = a.service.sends[0].key
        a.wallet.sessionDidChange(.ended)

        let b = WalletRig(store: a.store, user: WK.userTwo, keys: KeyMaker(digit: 3))
        b.service.queueTransfer(.failure(WK.offline))
        b.startPayment(note: "Rent")
        #expect(await waitUntil { b.failure != nil })
        let keyB = b.service.sends[0].key
        #expect(keyA != keyB)
        #expect(b.wallet.hasSavedPayments)

        #expect(b.wallet.prepareSignOut())
        #expect(b.store.obligation == SignOutObligation(entries: [.init(code: WK.userTwo.id, key: keyB)]), "the record names B's payment alone")
        b.wallet.sessionDidChange(.signedOutByChoice)
        #expect(b.store.snapshot.map(\.key) == [keyA])
        #expect(b.store.obligation == nil)

        let back = b.relaunched(user: WK.userOne)
        expectKept(back, key: keyA)
    }

    @Test("with only another user's payment on the phone, a signed-in user has nothing to be warned about")
    func warningIsAboutOwnPayments() async {
        let a = await unresolved()
        a.wallet.sessionDidChange(.ended)
        let b = a.relaunched(user: WK.userTwo)
        #expect(!b.wallet.hasSavedPayments)
        let report = SignOutGate.hasUnfinishedPayments(
            wallet: b.wallet, checkout: CheckoutController(service: FakeCheckout(), store: InMemoryPendingCheckoutStore()))
        #expect(!report.wallet)
    }

    @Test("a slot nobody can read has no knowable owner: it counts for, and goes with, whoever signs out or resets")
    func unreadableSlotsAreEveryonesProblem() async {
        let store = InMemoryPendingTransferStore()
        store.plantUnreadable(userID: "usr_unknown")
        let rig = WalletRig(store: store, user: WK.userOne)
        #expect(rig.wallet.hasSavedPayments)
        #expect(rig.wallet.prepareSignOut())
        #expect(store.obligation == SignOutObligation(entries: [.init(code: "usr_unknown", key: nil)]))
        rig.wallet.sessionDidChange(.signedOutByChoice)
        #expect(store.snapshot.isEmpty)
        #expect(store.obligation == nil)
    }
}
