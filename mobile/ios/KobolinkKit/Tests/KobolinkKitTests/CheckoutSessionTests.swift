import Foundation
import Testing

@testable import KobolinkKit

// MARK: - Lessons 4 and 5: per-user state, ownership

@MainActor
@Suite("Checkout: signing out and changing user")
struct CheckoutSessionStateTests {
    /// A signed-in merchant opens a link, types a payer's details, and starts a payment that cannot be confirmed.
    private func merchantAttempt(
        owner: AttemptOwner = .session(userID: CK.userOne.id), code: LinkCode = CK.codeA
    ) async -> CheckoutRig {
        let rig = CheckoutRig(owner: owner)
        await rig.openPayable(code)
        rig.fillForm()
        rig.service.queueInitialize(.failure(CK.offline))
        rig.controller.pay()
        _ = await waitUntil { rig.attemptScreen != nil }
        return rig
    }

    @Test("explicit sign-out empties the form fields, the amount included, in memory")
    func signOutEmptiesForm() async {
        let rig = CheckoutRig(owner: .session(userID: CK.userOne.id))
        await rig.openPayable(amountKobo: nil)
        rig.fillForm(amount: "5000")
        rig.controller.form.errors = [.email: "x"]
        let before = rig.controller.form.resetCount
        rig.service.queueLookup(.success(CK.lookup(amountKobo: nil)))
        rig.controller.sessionDidChange(.signedOutByChoice)
        let form = rig.controller.form
        #expect(form.name.isEmpty && form.email.isEmpty && form.amountText.isEmpty)
        #expect(form.errors.isEmpty)
        #expect(form.resetCount > before)
        // The link is shown again, fresh, to whoever is here now.
        #expect(await waitUntil { rig.linkScreen != nil })
        #expect(rig.linkScreen?.pay == .editing)
    }

    @Test("the next person to open the same link after a sign-out cannot re-send the previous request: there is nothing to send")
    func nextPersonGetsNothing() async {
        let rig = await merchantAttempt()
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.sessionDidChange(.signedOutByChoice)
        #expect(rig.store.snapshot.isEmpty)
        #expect(await waitUntil { rig.linkScreen != nil })
        #expect(rig.controller.form.isEmpty)
        rig.controller.retry()
        #expect(rig.service.sends.count == 1)
        // A second person's own payment is a new attempt with a new key.
        rig.fillForm(name: "Someone Else", email: "else@example.test")
        rig.service.queueInitialize(.success(CK.started()))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen?.phase == .startedUnverified })
        #expect(Set(rig.service.sends.map(\.key)).count == 2)
        #expect(rig.service.sends[1].request.payerName == "Someone Else")
    }

    @Test("an answer that arrives after sign-out is dropped: it does not bring the attempt back")
    func answerAfterSignOut() async {
        let rig = CheckoutRig(owner: .session(userID: CK.userOne.id))
        await rig.openPayable()
        rig.fillForm()
        let gate = Gate()
        rig.service.queueInitialize(.success(CK.started()), gate: gate)
        rig.controller.pay()
        #expect(await waitUntil { rig.service.sends.count == 1 })
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.sessionDidChange(.signedOutByChoice)
        #expect(rig.store.snapshot.isEmpty)
        gate.open()
        await rig.settle()
        #expect(rig.store.snapshot.isEmpty)
        #expect(rig.attemptScreen == nil)
    }

    @Test("a payer's attempt survives a merchant signing out; the merchant's own does not")
    func payerSurvives() async {
        let payer = await merchantAttempt(owner: .payer)
        payer.service.queueLookup(.success(CK.lookup()))
        payer.controller.sessionDidChange(.signedOutByChoice)
        #expect(payer.store.snapshot.count == 1)
        #expect(await waitUntil { payer.attemptScreen?.phase == .unsettled(.interrupted) })

        let merchant = await merchantAttempt(owner: .session(userID: CK.userOne.id))
        merchant.service.queueLookup(.success(CK.lookup()))
        merchant.controller.sessionDidChange(.signedOutByChoice)
        #expect(merchant.store.snapshot.isEmpty)
    }

    @Test("sign-out removes every session attempt on the device, on other links too")
    func signOutClearsAllLinks() async {
        let rig = await merchantAttempt(code: CK.codeA)
        await rig.openPayable(CK.codeB)
        rig.fillForm()
        rig.service.queueInitialize(.failure(CK.offline))
        rig.controller.pay()
        #expect(await waitUntil { rig.store.snapshot.count == 2 })
        rig.service.queueLookup(.success(CK.lookup(CK.codeB)))
        rig.controller.sessionDidChange(.signedOutByChoice)
        #expect(rig.store.snapshot.isEmpty)
    }

    // MARK: ownership of an attempt made before the session was known

    @Test("an attempt made while the session was resolving is owned by nobody yet, then by the user the check confirms")
    func resolvingAttemptIsAdopted() async {
        let rig = await merchantAttempt(owner: .session(userID: nil))
        #expect(rig.store.snapshot.first?.owner == .session(userID: nil))
        rig.controller.sessionDidChange(.resolved(CK.userOne))
        #expect(rig.store.snapshot.first?.owner == .session(userID: CK.userOne.id))
        // It is still on screen, with its key: confirmation changes nobody's attempt.
        #expect(rig.attemptScreen?.phase == .unsettled(.noConnection))
        // And now an explicit sign-out removes it.
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.sessionDidChange(.signedOutByChoice)
        #expect(rig.store.snapshot.isEmpty)
    }

    @Test("an attempt made while offline is not an orphan: explicit sign-out removes it before it is ever confirmed")
    func offlineAttemptRemovedBySignOut() async {
        let rig = await merchantAttempt(owner: .session(userID: nil))
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.sessionDidChange(.signedOutByChoice)
        #expect(rig.store.snapshot.isEmpty)
    }

    @Test("an involuntary end leaves an unconfirmed attempt where it is, for the same person to resume")
    func expiryKeepsUnconfirmed() async {
        let rig = await merchantAttempt(owner: .session(userID: nil))
        rig.controller.sessionDidChange(.ended)
        #expect(rig.store.snapshot.count == 1)
        #expect(rig.attemptScreen?.phase == .unsettled(.noConnection))
    }

    @Test("a different user signing in removes the previous user's CONFIRMED attempt")
    func differentUserClears() async {
        let confirmed = await merchantAttempt(owner: .session(userID: CK.userOne.id))
        confirmed.controller.sessionDidChange(.ended)
        confirmed.service.queueLookup(.success(CK.lookup()))
        confirmed.controller.sessionDidChange(.signedIn(CK.userTwo))
        #expect(confirmed.store.snapshot.isEmpty)
        #expect(await waitUntil { confirmed.linkScreen != nil })
        #expect(confirmed.controller.form.isEmpty)
    }

    @Test("signing in NEVER drops an unconfirmed attempt: the person who signs in adopts it, with its key and reference")
    func signInAdoptsUnconfirmed() async {
        for user in [CK.userOne, CK.userTwo] {
            let rig = await merchantAttempt(owner: .session(userID: nil))
            let key = rig.store.snapshot.first?.key
            rig.controller.sessionDidChange(.ended)
            rig.controller.sessionDidChange(.signedIn(user))
            #expect(rig.store.snapshot.count == 1)
            #expect(rig.store.snapshot.first?.key == key)
            #expect(rig.store.snapshot.first?.owner == .session(userID: user.id))
        }
    }

    @Test("the SAME person signing back in after an unknown outcome retries the same request under the same key, not a new one")
    func samePersonSignsBackIn() async {
        // Cold start with a token that has expired: the link opens while the session is resolving, Pay saves an
        // attempt with no owner, the POST times out, /me answers 401, and the same merchant signs in again.
        let rig = CheckoutRig(owner: .session(userID: nil))
        await rig.openPayable()
        rig.fillForm()
        rig.service.queueInitialize(.failure(.unreachable(.timedOut)))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen?.phase == .unsettled(.noConnection) })
        rig.controller.sessionDidChange(.ended)
        rig.controller.sessionDidChange(.signedIn(CK.userOne))
        #expect(await waitUntil { rig.attemptScreen?.phase == .unsettled(.interrupted) })
        #expect(rig.linkScreen == nil)
        rig.service.queueInitialize(.success(CK.started()))
        rig.controller.retry()
        #expect(await waitUntil { rig.attemptScreen?.phase == .startedUnverified })
        #expect(rig.keys.made == 1)
        #expect(Set(rig.service.sends.map(\.key)).count == 1)
        #expect(rig.service.sends.count == 2 && rig.service.sends[0].request == rig.service.sends[1].request)
    }

    @Test("the offline then Try Again then 401 then sign-in route keeps the attempt too, with its reference")
    func offlineRoute() async {
        let rig = CheckoutRig(owner: .session(userID: nil))
        await rig.openPayable()
        rig.fillForm()
        rig.service.queueInitialize(.success(CK.started()))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen?.phase == .startedUnverified })
        rig.controller.sessionDidChange(.ended)
        rig.controller.sessionDidChange(.signedIn(CK.userOne))
        #expect(rig.attemptScreen?.reference == CK.reference)
        #expect(rig.store.snapshot.first?.reference == CK.reference)
    }

    @Test("if adopting the attempt cannot be saved, the attempt is KEPT and adoption is retried; nothing is swallowed")
    func adoptionFailureKeepsAttempt() async {
        let rig = await merchantAttempt(owner: .session(userID: nil))
        let key = rig.store.snapshot.first?.key
        rig.controller.sessionDidChange(.ended)
        rig.store.fail(.write)
        rig.controller.sessionDidChange(.signedIn(CK.userOne))
        #expect(rig.store.snapshot.count == 1)
        #expect(rig.store.snapshot.first?.owner == .session(userID: nil))
        #expect(rig.attemptScreen?.phase == .unsettled(.interrupted))
        // Storage recovers; the next time the link is shown, adoption is retried and succeeds.
        rig.store.heal()
        rig.controller.reload()
        #expect(rig.store.snapshot.first?.owner == .session(userID: CK.userOne.id))
        #expect(rig.store.snapshot.first?.key == key)
        // ... so a later sign-out of that user removes it.
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.sessionDidChange(.signedOutByChoice)
        #expect(rig.store.snapshot.isEmpty)
    }

    @Test("the same user signing in again after an expiry keeps their own confirmed attempt")
    func sameUserKeeps() async {
        let rig = await merchantAttempt(owner: .session(userID: CK.userOne.id))
        rig.controller.sessionDidChange(.ended)
        rig.controller.sessionDidChange(.signedIn(CK.userOne))
        #expect(rig.store.snapshot.count == 1)
        #expect(await waitUntil { rig.attemptScreen?.phase == .unsettled(.interrupted) })
        rig.service.queueInitialize(.success(CK.started()))
        rig.controller.retry()
        #expect(await waitUntil { rig.attemptScreen?.phase == .startedUnverified })
        #expect(rig.keys.made == 1)
    }

    @Test("a payer's attempt is not touched when a merchant signs in")
    func payerSurvivesSignIn() async {
        let rig = await merchantAttempt(owner: .payer)
        rig.controller.sessionDidChange(.signedIn(CK.userOne))
        #expect(rig.store.snapshot.count == 1)
    }

    @Test("the check confirming a DIFFERENT user than the last one clears the form and the other user's attempts")
    func resolvedDifferentUser() async {
        let rig = await merchantAttempt(owner: .session(userID: CK.userOne.id))
        rig.controller.sessionDidChange(.resolved(CK.userOne))
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.sessionDidChange(.resolved(CK.userTwo))
        #expect(rig.store.snapshot.isEmpty)
        #expect(rig.controller.form.isEmpty)
    }

    @Test("the check confirming the user does not wipe a form the person is typing into")
    func resolvedKeepsTyping() async {
        let rig = CheckoutRig(owner: .session(userID: nil))
        await rig.openPayable()
        rig.fillForm()
        rig.controller.sessionDidChange(.resolved(CK.userOne))
        #expect(rig.controller.form.name == CK.payerName)
        #expect(rig.linkScreen != nil)
    }

    // MARK: a removal that fails is not swallowed

    @Test("if sign-out cannot remove an attempt, it is hidden from the next person until it can")
    func failedSignOutCleanup() async {
        let rig = await merchantAttempt(owner: .session(userID: CK.userOne.id))
        rig.store.fail(.remove)
        rig.controller.sessionDidChange(.signedOutByChoice)
        #expect(rig.store.snapshot.count == 1)
        // The next person opens the link: not the previous user's attempt, and no way to resend it.
        #expect(rig.controller.screen == .storageBlocked(CK.codeA, .cannotClear))
        rig.controller.retry()
        #expect(rig.service.sends.count == 1)
        #expect(rig.service.lookups.count == 1)
        // Storage recovers: the next open removes it and carries on.
        rig.store.heal()
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.reload()
        #expect(await waitUntil { rig.linkScreen != nil })
        #expect(rig.store.snapshot.isEmpty)
    }

    @Test("a payer's attempt on another link is still shown while a sign-out cleanup is outstanding")
    func failedCleanupSparesPayer() async {
        let store = InMemoryPendingCheckoutStore()
        try? store.save(CK.pending(CK.codeA, owner: .session(userID: CK.userOne.id)))
        try? store.save(CK.pending(CK.codeB, key: "00000000-0000-4000-8000-00000000000B", owner: .payer))
        let rig = CheckoutRig(store: store)
        store.fail(.remove)
        rig.controller.sessionDidChange(.signedOutByChoice)
        rig.controller.open(CK.codeB)
        #expect(rig.attemptScreen?.phase == .unsettled(.interrupted))
        rig.controller.open(CK.codeA)
        #expect(rig.controller.screen == .storageBlocked(CK.codeA, .cannotClear))
    }

    @Test("a sign-out cleanup that failed is still owed after a restart: the next process does not show the attempt")
    func cleanupSurvivesRestart() async {
        let store = InMemoryPendingCheckoutStore()
        try? store.save(CK.pending(CK.codeA, owner: .session(userID: CK.userOne.id)))
        try? store.save(CK.pending(CK.codeB, key: "00000000-0000-4000-8000-00000000000B", owner: .payer))
        let first = CheckoutRig(store: store)
        store.fail(.remove)
        first.controller.sessionDidChange(.signedOutByChoice)
        #expect(store.snapshot.count == 2)

        // A new process over the same storage, with the failure still in place: blocked, never shown.
        let second = first.relaunched()
        second.controller.open(CK.codeA)
        #expect(second.controller.screen == .storageBlocked(CK.codeA, .cannotClear))
        #expect(second.service.lookups.isEmpty)
        second.controller.open(CK.codeB)
        #expect(second.attemptScreen?.phase == .unsettled(.interrupted))

        // Storage recovers: the owed cleanup runs before any slot is presented, and the payer's stays.
        store.heal()
        second.service.queueLookup(.success(CK.lookup()))
        second.controller.open(CK.codeA)
        #expect(await waitUntil { second.linkScreen != nil })
        #expect(store.snapshot.map(\.request.code) == [CK.codeB])

        // And it is not owed any more: a third process shows nothing special, and a NEW session attempt survives.
        let third = second.relaunched(owner: .session(userID: CK.userTwo.id))
        await third.openPayable(CK.codeA)
        third.fillForm()
        third.service.queueInitialize(.failure(CK.offline))
        third.controller.pay()
        #expect(await waitUntil { third.attemptScreen != nil })
        third.controller.open(CK.codeA)
        #expect(third.attemptScreen != nil)
        #expect(store.snapshot.count == 2)
    }

    @Test("an obligation that cannot be read at cold start blocks the link rather than guessing")
    func unreadableObligation() async {
        let store = InMemoryPendingCheckoutStore()
        try? store.save(CK.pending(CK.codeA, owner: .payer))
        store.fail(.obligation)
        let rig = CheckoutRig(store: store)
        rig.controller.open(CK.codeA)
        #expect(rig.controller.screen == .storageBlocked(CK.codeA, .unreadable))
        store.heal()
        rig.controller.reload()
        #expect(rig.attemptScreen != nil)
    }

    @Test("an unreadable slot is removed by sign-out too")
    func signOutRemovesUnreadable() async {
        let store = InMemoryPendingCheckoutStore()
        store.plantUnreadable(CK.codeA)
        let rig = CheckoutRig(store: store)
        rig.controller.sessionDidChange(.signedOutByChoice)
        #expect((try? store.all()) == [])
    }

    @Test("hasSessionAttempts is true when a session attempt exists, for the sign-out confirmation")
    func hasSessionAttempts() async {
        let payer = await merchantAttempt(owner: .payer)
        #expect(!payer.controller.hasSessionAttempts)
        let session = await merchantAttempt(owner: .session(userID: CK.userOne.id))
        #expect(session.controller.hasSessionAttempts)
        session.store.fail(.list)
        #expect(session.controller.hasSessionAttempts)
    }
}

// MARK: - Lesson 7 and 8: latest wins, Back, cold and warm

@MainActor
@Suite("Checkout: latest wins")
struct CheckoutLatestWinsTests {
    @Test("a lookup answer for the link the person has since left is dropped")
    func staleLookup() async {
        let rig = CheckoutRig()
        let slowA = Gate()
        rig.service.queueLookup(.success(CK.lookup(CK.codeA)), gate: slowA)
        rig.controller.open(CK.codeA)
        rig.service.queueLookup(.success(CK.lookup(CK.codeB, amountKobo: 500_000)))
        rig.controller.open(CK.codeB)
        #expect(await waitUntil { rig.linkScreen?.link.code == CK.codeB })
        slowA.open()
        await rig.settle()
        #expect(rig.linkScreen?.link.code == CK.codeB)
        #expect(rig.linkScreen?.link.amountKobo == 500_000)
    }

    @Test("a second lookup for the SAME link supersedes the first")
    func staleLookupSameLink() async {
        let rig = CheckoutRig()
        let slow = Gate()
        rig.service.queueLookup(.success(CK.lookup(amountKobo: 1_000_000)), gate: slow)
        rig.controller.open(CK.codeA)
        rig.service.queueLookup(.success(CK.lookup(amountKobo: 2_000_000)))
        rig.controller.reload()
        #expect(await waitUntil { rig.linkScreen?.link.amountKobo == 2_000_000 })
        slow.open()
        await rig.settle()
        #expect(rig.linkScreen?.link.amountKobo == 2_000_000)
    }

    @Test("a lookup answer after Back is dropped: the screen stays closed")
    func lookupAfterClose() async {
        let rig = CheckoutRig()
        let slow = Gate()
        rig.service.queueLookup(.success(CK.lookup()), gate: slow)
        rig.controller.open(CK.codeA)
        rig.controller.close()
        slow.open()
        await rig.settle()
        #expect(rig.controller.screen == .idle)
    }

    @Test("a payment answer for the link the person has left does not touch the screen, but its reference is stored")
    func stalePaymentAnswer() async {
        let rig = CheckoutRig()
        await rig.openPayable(CK.codeA)
        rig.fillForm()
        let gate = Gate()
        rig.service.queueInitialize(.success(CK.started()), gate: gate)
        rig.controller.pay()
        #expect(await waitUntil { rig.service.sends.count == 1 })
        rig.service.queueLookup(.success(CK.lookup(CK.codeB, amountKobo: 500_000)))
        rig.controller.open(CK.codeB)
        #expect(await waitUntil { rig.linkScreen?.link.code == CK.codeB })
        gate.open()
        await rig.settle()
        #expect(rig.linkScreen?.link.code == CK.codeB)
        #expect(rig.store.snapshot.first?.reference == CK.reference)
        // Going back to A shows the started payment.
        rig.controller.open(CK.codeA)
        #expect(rig.attemptScreen?.reference == CK.reference)
    }

    @Test("a payment answer after Back does not reopen the screen")
    func paymentAnswerAfterClose() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        rig.fillForm()
        let gate = Gate()
        rig.service.queueInitialize(.success(CK.started()), gate: gate)
        rig.controller.pay()
        #expect(await waitUntil { rig.service.sends.count == 1 })
        rig.controller.close()
        gate.open()
        await rig.settle()
        #expect(rig.controller.screen == .idle)
        #expect(rig.store.snapshot.first?.reference == CK.reference)
    }

    @Test("re-opening while the request is still in the air shows it as sending, and the answer then lands on the screen")
    func reopenWhileInFlight() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        rig.fillForm()
        let gate = Gate()
        rig.service.queueInitialize(.success(CK.started()), gate: gate)
        rig.controller.pay()
        #expect(await waitUntil { rig.service.sends.count == 1 })
        rig.controller.close()
        rig.controller.open(CK.codeA)
        #expect(rig.attemptScreen?.phase == .sending)
        rig.controller.retry()
        #expect(rig.service.sends.count == 1)
        gate.open()
        #expect(await waitUntil { rig.attemptScreen?.phase == .startedUnverified })
    }

    @Test("Back never lands on a stale form: the fields are empty when the link is opened again")
    func backClearsForm() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        rig.fillForm()
        rig.controller.close()
        #expect(rig.controller.form.isEmpty)
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.open(CK.codeA)
        #expect(await waitUntil { rig.linkScreen != nil })
        #expect(rig.controller.form.isEmpty)
        #expect(rig.linkScreen?.pay == .editing)
    }

    @Test("a different link starts with an empty form; the same link re-opened keeps what was typed")
    func formFollowsLink() async {
        let rig = CheckoutRig()
        await rig.openPayable(CK.codeA)
        rig.fillForm()
        rig.service.queueLookup(.success(CK.lookup(CK.codeA)))
        rig.controller.reload()
        #expect(await waitUntil { rig.linkScreen != nil })
        #expect(rig.controller.form.name == CK.payerName)
        await rig.openPayable(CK.codeB)
        #expect(rig.controller.form.isEmpty)
    }

    @Test("cold start and a warm second link both land on their own link")
    func coldThenWarm() async {
        let rig = CheckoutRig()
        await rig.openPayable(CK.codeA)
        #expect(rig.linkScreen?.link.code == CK.codeA)
        await rig.openPayable(CK.codeB, amountKobo: nil)
        #expect(rig.linkScreen?.link.code == CK.codeB)
        #expect(rig.linkScreen?.link.amountKobo == nil)
        #expect(rig.service.lookups == [CK.codeA, CK.codeB])
    }
}

// MARK: - The verdict, on its own

@Suite("Checkout: what an answer lets the app conclude")
struct SendVerdictTests {
    private let request = CK.request()

    private func verdict(_ error: APIError, first: Bool) -> SendVerdict {
        SendVerdict.of(.failure(error), request: request, firstEverSend: first)
    }

    @Test("only the three stored refusals, with moneyMoved false and their own status, settle an attempt, first send or replay")
    func settledOnlyThree() {
        for first in [true, false] {
            if case .settled = verdict(CK.notFound, first: first) {} else { Issue.record("not_found") }
            if case .settled = verdict(CK.linkNotPayable, first: first) {} else { Issue.record("link_not_payable") }
            if case .settled = verdict(CK.amountMismatch, first: first) {} else { Issue.record("amount_mismatch") }
        }
    }

    @Test("validation_failed settles only the first send ever")
    func validationFirstOnly() {
        let validation = CK.refusal(.validation_failed, status: 400, moneyMoved: nil, fields: ["payerName": ["x"]])
        if case .rejected = verdict(validation, first: true) {} else { Issue.record("first send should be rejected") }
        if case .unsettled(.refused) = verdict(validation, first: false) {} else { Issue.record("replay must stay unsettled") }
        // moneyMoved true is never a clean refusal.
        let impossible = CK.refusal(.validation_failed, status: 400, moneyMoved: true)
        if case .unsettled = verdict(impossible, first: true) {} else { Issue.record("moneyMoved true") }
    }

    @Test("rate limits, server errors, redirects and unreadable answers are unknown")
    func unknowns() {
        #expect(verdict(CK.refusal(.rate_limited, status: 429, moneyMoved: nil), first: true) == .unsettled(.rateLimited(retryAfterSeconds: nil)))
        #expect(verdict(CK.refusal(._internal, status: 500, moneyMoved: nil), first: true) == .unsettled(.serverProblem))
        #expect(verdict(.unexpectedResponse(status: 502), first: true) == .unsettled(.serverProblem))
        #expect(verdict(.unexpectedResponse(status: 302), first: true) == .unsettled(.unreadable))
        #expect(verdict(.undecodableResponse, first: true) == .unsettled(.unreadable))
        #expect(verdict(.unreachable(.timedOut), first: true) == .unsettled(.noConnection))
        #expect(verdict(.cancelled, first: true) == .unsettled(.noConnection))
    }
}
