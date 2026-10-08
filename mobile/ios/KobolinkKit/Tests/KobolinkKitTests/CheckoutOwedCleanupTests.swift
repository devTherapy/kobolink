import Foundation
import Testing

@testable import KobolinkKit

/// A sign-out whose clearing failed is OWED, and what is owed is read before anything else a session event does.
@MainActor
@Suite("Checkout: an owed sign-out cleanup is read before anything else")
struct CheckoutOwedCleanupTests {
    /// A (offline, session not yet confirmed) pays link L and the outcome is unknown; A signs out and the Keychain
    /// will not remove the attempt, so the removal is owed.
    private func stuckSignOut() async -> CheckoutRig {
        let rig = CheckoutRig(owner: .session(userID: nil))
        await rig.openPayable()
        rig.fillForm()
        rig.service.queueInitialize(.failure(CK.offline))
        rig.controller.pay()
        _ = await waitUntil { rig.attemptScreen != nil }
        rig.store.fail(.remove)
        rig.controller.sessionDidChange(.signedOutByChoice)
        return rig
    }

    private func openFreshLink(_ rig: CheckoutRig) async {
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.open(CK.codeA)
        _ = await waitUntil { rig.linkScreen != nil }
    }

    @Test("relaunch, then B signs in BEFORE any link opens: A's attempt is removed, not adopted by B and shown to B")
    func relaunchThenSignedIn() async {
        let first = await stuckSignOut()
        #expect(first.store.snapshot.count == 1)
        first.store.heal()
        let second = first.relaunched()
        second.controller.sessionDidChange(.signedIn(CK.userTwo))
        #expect(second.store.snapshot.isEmpty)
        await openFreshLink(second)
        #expect(second.attemptScreen == nil)
        #expect(second.linkScreen != nil)
    }

    @Test("relaunch, then the check confirms B BEFORE any link opens: the same")
    func relaunchThenResolved() async {
        let first = await stuckSignOut()
        first.store.heal()
        let second = first.relaunched()
        second.controller.sessionDidChange(.resolved(CK.userTwo))
        #expect(second.store.snapshot.isEmpty)
        await openFreshLink(second)
        #expect(second.attemptScreen == nil)
    }

    @Test("B signs in in the SAME process while the removal still fails: A's attempt is not relabelled, and is hidden from B")
    func sameProcessSignIn() async {
        let rig = await stuckSignOut()
        rig.controller.sessionDidChange(.signedIn(CK.userTwo))
        #expect(rig.store.snapshot.first?.owner == .session(userID: nil))
        rig.controller.open(CK.codeA)
        #expect(rig.controller.screen == .storageBlocked(CK.codeA, .cannotClear))
        #expect(rig.service.sends.count == 1)
    }

    @Test("then a cold start confirms B while the removal STILL fails: still not relabelled, still hidden, and removed once it works")
    func nextColdStart() async {
        let first = await stuckSignOut()
        first.controller.sessionDidChange(.signedIn(CK.userTwo))
        let second = first.relaunched()
        second.controller.sessionDidChange(.resolved(CK.userTwo))
        #expect(second.store.snapshot.first?.owner == .session(userID: nil))
        second.controller.open(CK.codeA)
        #expect(second.controller.screen == .storageBlocked(CK.codeA, .cannotClear))
        first.store.heal()
        await openFreshLink(second)
        #expect(second.store.snapshot.isEmpty)
        #expect(second.attemptScreen == nil)
    }

    @Test("an unreadable slot the sign-out was to clear is not forgotten by the next session event")
    func unreadableSlotStillOwed() async {
        let store = InMemoryPendingCheckoutStore()
        store.plantUnreadable(CK.codeA)
        let first = CheckoutRig(store: store)
        store.fail(.remove)
        first.controller.sessionDidChange(.signedOutByChoice)
        store.heal()
        let second = first.relaunched()
        second.controller.sessionDidChange(.signedIn(CK.userTwo))
        #expect((try? store.all()) == [])
    }

    @Test("the clock set BACK before the sign-out does not let the signing-out user's attempt survive it")
    func clockBackBeforeSignOut() async {
        let rig = CheckoutRig(owner: .session(userID: CK.userOne.id))
        await rig.openPayable()
        rig.fillForm()
        rig.service.queueInitialize(.failure(CK.offline))
        rig.controller.pay()
        _ = await waitUntil { rig.attemptScreen != nil }
        rig.clock.value = Date(timeIntervalSince1970: 1_000_000_000)
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.sessionDidChange(.signedOutByChoice)
        #expect(rig.store.snapshot.isEmpty)
    }

    @Test("a later session's attempt is never removed by a cleanup still owed, whatever the clock says")
    func laterAttemptSurvivesLeftoverCleanup() async {
        let first = await stuckSignOut()
        // C signs in, with the clock earlier than A's attempt, and starts a payment on another link.
        first.owner.value = .session(userID: CK.userTwo.id)
        first.clock.value = Date(timeIntervalSince1970: 1_000_000_000)
        first.controller.sessionDidChange(.signedIn(CK.userTwo))
        first.service.queueLookup(.success(CK.lookup(CK.codeB)))
        first.controller.open(CK.codeB)
        _ = await waitUntil { first.linkScreen != nil }
        first.fillForm(name: "Chidi Eze", email: "chidi@example.test")
        first.service.queueInitialize(.failure(CK.offline))
        first.controller.pay()
        _ = await waitUntil { first.attemptScreen != nil }
        let laterKey = first.store.snapshot.first { $0.request.code == CK.codeB }?.key
        #expect(laterKey != nil)
        // Storage recovers and the owed removal runs.
        first.store.heal()
        first.service.queueLookup(.success(CK.lookup()))
        first.controller.open(CK.codeA)
        _ = await waitUntil { first.linkScreen != nil }
        #expect(first.store.snapshot.map(\.request.code) == [CK.codeB])
        #expect(first.store.snapshot.first?.key == laterKey)
    }

    // MARK: a sign-out that cannot be made safe does not happen

    private func attemptRig(owner: AttemptOwner = .session(userID: CK.userOne.id)) async -> CheckoutRig {
        let rig = CheckoutRig(owner: owner)
        await rig.openPayable()
        rig.fillForm()
        rig.service.queueInitialize(.failure(CK.offline))
        rig.controller.pay()
        _ = await waitUntil { rig.attemptScreen != nil }
        return rig
    }

    @Test("the sign-out is prepared: what it owes is written down, by key, BEFORE anything is removed")
    func prepareWritesObligation() async {
        let rig = await attemptRig()
        let key = rig.store.snapshot.first?.key
        #expect(rig.controller.prepareSignOut())
        #expect(rig.store.obligation?.entries == [.init(code: CK.codeA.value, key: key)])
        #expect(rig.store.snapshot.count == 1)
    }

    @Test("with nothing owed, the sign-out is safe and writes nothing")
    func nothingOwed() async {
        let rig = await attemptRig(owner: .payer)
        #expect(rig.controller.prepareSignOut())
        #expect(rig.store.obligation == nil)
        #expect(CheckoutRig().controller.prepareSignOut())
    }

    @Test("if what it owes cannot be written down, the sign-out is NOT safe: it must not happen")
    func obligationWriteFails() async {
        let rig = await attemptRig()
        rig.store.fail(.obligation)
        #expect(!rig.controller.prepareSignOut())
        #expect(rig.store.obligation == nil)
        #expect(rig.store.snapshot.count == 1)
    }

    @Test("if the device's attempts cannot be listed, or an earlier obligation cannot be read, the sign-out is NOT safe")
    func cannotKnow() async {
        let listing = await attemptRig()
        listing.store.fail(.list)
        #expect(!listing.controller.prepareSignOut())
        let unreadable = await attemptRig()
        unreadable.store.fail(.obligation, as: .undecodable)
        #expect(!unreadable.controller.prepareSignOut())
    }

    @Test("a sign-out that was not prepared still hides every session attempt, rather than showing it")
    func unpreparedSignOutHides() async {
        let rig = await attemptRig()
        rig.store.fail(.obligation)
        rig.controller.sessionDidChange(.signedOutByChoice)
        rig.controller.open(CK.codeA)
        #expect(rig.controller.screen == .storageBlocked(CK.codeA, .cannotClear))
    }

    // MARK: no way out of a record that cannot be read

    @Test("an obligation this build cannot read blocks every link, offers a reset, and the reset forgets everything and opens the link")
    func resetCheckoutData() async {
        let store = InMemoryPendingCheckoutStore()
        try? store.save(CK.pending(CK.codeA, owner: .payer))
        try? store.save(CK.pending(CK.codeB, key: "00000000-0000-4000-8000-00000000000B", owner: .session(userID: nil)))
        store.fail(.obligation, as: .undecodable)
        let rig = CheckoutRig(store: store)
        rig.controller.open(CK.codeA)
        #expect(rig.controller.screen == .storageBlocked(CK.codeA, .obligationUnreadable))
        #expect(rig.service.lookups.isEmpty)
        // Storage still refuses to take the record back: the screen says so, and the link stays shut.
        rig.controller.resetCheckoutData()
        #expect(rig.controller.screen == .storageBlocked(CK.codeA, .resetFailed))
        #expect(rig.service.lookups.isEmpty)
        // It lets go: every slot and the record are gone, and the link opens as a fresh one.
        store.heal()
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.resetCheckoutData()
        #expect(await waitUntil { rig.linkScreen != nil })
        #expect(store.snapshot.isEmpty)
        #expect(store.obligation == nil)
    }

    @Test("a record that merely cannot be reached right now has no reset: only Try Again")
    func unavailableHasNoReset() {
        let store = InMemoryPendingCheckoutStore()
        try? store.save(CK.pending(CK.codeA, owner: .payer))
        store.fail(.obligation)
        let rig = CheckoutRig(store: store)
        rig.controller.open(CK.codeA)
        #expect(rig.controller.screen == .storageBlocked(CK.codeA, .unreadable))
        rig.controller.resetCheckoutData()
        #expect(store.snapshot.count == 1)
        #expect(rig.controller.screen == .storageBlocked(CK.codeA, .unreadable))
    }

    @Test("the reset says what it forgets, and the blocked copy names it")
    func resetCopy() {
        #expect(CheckoutCopy.resetMessage.contains("If you already paid, check with the merchant first."))
        for block in [StorageBlock.obligationUnreadable, .resetFailed] {
            let notice = CheckoutCopy.storageBlocked(block)
            #expect(notice.moneyLine == "A payment may already have been started on this link.")
            #expect(!notice.moneyLine.contains("Nothing was sent"))
        }
        #expect(CheckoutCopy.storageBlocked(.obligationUnreadable).nextStep.contains("Resetting checkout data"))
    }

    @Test("a different person who adopted an attempt is not told they started it")
    func neutralCopy() {
        let words = [CheckoutCopy.signOutWarning, CheckoutCopy.unsettledBody(.interrupted), CheckoutCopy.startOverMessage(reference: nil, merchant: "M")]
            .joined(separator: " ")
        #expect(!words.contains("you started"))
        #expect(!words.contains("This payment was started"))
        #expect(CheckoutCopy.signOutWarning.hasPrefix("A payment on this iPhone was started and not finished."))
        #expect(CheckoutCopy.signOutWarning.contains("check with the merchant first"))
    }
}
