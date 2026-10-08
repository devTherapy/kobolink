import Foundation
import KobolinkAPI
import Testing

@testable import KobolinkKit

// Feature I4: a started payment is confirmed by `verify`, and only by `verify`. Every name, email and reference
// below is invented for these tests.

// MARK: - What each answer decides (the verdict table)

@Suite("Verify: what each answer decides")
struct VerifyVerdictTests {
    private func verdict(_ result: Result<VerifiedPayment, APIError>) -> VerifyVerdict {
        VerifyVerdict.of(result, reference: CK.reference, code: CK.codeA, amountKobo: 1_850_000)
    }

    @Test("the server's own words decide: success with money moved is paid, failed without it is not")
    func decided() {
        #expect(verdict(.success(CK.paid)) == .decided(.paid))
        #expect(verdict(.success(CK.declined)) == .decided(.declined(reason: "Card declined by the simulated gateway.")))
        #expect(verdict(.success(CK.payment(.failed))) == .decided(.declined(reason: nil)))
        #expect(verdict(.success(CK.payment(.pending))) == .notDecided)
    }

    @Test("a failure for a link reason is that link state, matched on the server's exact sentence; any other reason stays the server's own words")
    func linkReasons() {
        let cases: [(String, PaymentResult)] = [
            ("Link is disabled", .linkDisabled),
            ("Link has expired", .linkExpired),
            ("Link is already paid", .linkAlreadyPaid),
            ("  Link has expired \n", .linkExpired),
            ("Link no longer exists", .declined(reason: "Link no longer exists")),
            ("link has expired", .declined(reason: "link has expired")),
            ("Your bank said no", .declined(reason: "Your bank said no")),
        ]
        for (reason, expected) in cases {
            let result = verdict(.success(CK.payment(.failed, reason: reason)))
            // A reason is trimmed by the client before it gets here, so the verdict sees it as given.
            guard case .decided(let got) = result else { Issue.record("\(reason): \(result)"); continue }
            if case .declined(let kept) = expected, case .declined(let gotReason) = got {
                #expect(gotReason == kept, "\(reason)")
            } else {
                #expect(got == expected, "\(reason)")
            }
        }
    }

    @Test("a refusal decides only when it says no money moved AND is the exact refusal the server stores for the reference")
    func refusalsThatDecide() {
        #expect(verdict(.failure(CK.refusal(.not_found, status: 404, message: "No checkout with that reference."))) == .decided(.checkoutNotFound))
        for (state, expected) in [
            (Components.Schemas.ApiError.statePayload.disabled, PaymentResult.linkDisabled),
            (.expired, .linkExpired),
            (.already_hyphen_paid, .linkAlreadyPaid),
        ] {
            #expect(verdict(.failure(CK.refusal(.link_not_payable, status: 409, state: state))) == .decided(expected))
        }
    }

    @Test("nothing else decides: the amount of what is not known is exactly what the copy then admits")
    func undecided() {
        let cases: [(String, Result<VerifiedPayment, APIError>, Unconfirmed)] = [
            ("offline", .failure(CK.offline), .noConnection),
            ("cancelled", .failure(.cancelled), .noConnection),
            ("502 page", .failure(.unexpectedResponse(status: 502)), .serverProblem),
            ("500", .failure(CK.refusal(._internal, status: 500, moneyMoved: nil)), .serverProblem),
            ("503 parsed", .failure(CK.refusal(.conflict, status: 503, moneyMoved: nil)), .serverProblem),
            ("429", .failure(CK.refusal(.rate_limited, status: 429, moneyMoved: nil)), .rateLimited(retryAfterSeconds: nil)),
            ("302", .failure(.unexpectedResponse(status: 302)), .unreadable),
            ("401 page", .failure(.unexpectedResponse(status: 401)), .unreadable),
            ("401 parsed", .failure(CK.refusal(.unauthenticated, status: 401, message: "Sign in.", moneyMoved: nil)), .unreadable),
            ("403 parsed", .failure(CK.refusal(.forbidden, status: 403, moneyMoved: nil)), .unreadable),
            ("unreadable body", .failure(.undecodableResponse), .unreadable),
            ("validation, money not moved", .failure(CK.refusal(.validation_failed, status: 400, message: "Bad.", moneyMoved: false)), .refused(message: "Bad.")),
            ("idempotency mismatch", .failure(CK.refusal(.idempotency_mismatch, status: 422, message: "Key reused.")), .refused(message: "Key reused.")),
            ("not_found, money not stated", .failure(CK.refusal(.not_found, status: 404, message: "Gone.", moneyMoved: nil)), .refused(message: "Gone.")),
            ("not_found on the wrong status", .failure(CK.refusal(.not_found, status: 400, message: "Gone.")), .refused(message: "Gone.")),
            ("link_not_payable with no state", .failure(CK.refusal(.link_not_payable, status: 409, message: "No.")), .refused(message: "No.")),
            ("link_not_payable, state payable", .failure(CK.refusal(.link_not_payable, status: 409, message: "No.", state: .payable)), .refused(message: "No.")),
            ("link_not_payable, money not stated", .failure(CK.refusal(.link_not_payable, status: 409, message: "No.", moneyMoved: nil, state: .expired)), .refused(message: "No.")),
            ("link_not_payable on the wrong status", .failure(CK.refusal(.link_not_payable, status: 422, message: "No.", state: .expired)), .refused(message: "No.")),
            ("another reference", .success(CK.payment(.success, reference: CK.otherReference)), .unreadable),
            ("another link", .success(CK.payment(.success, code: CK.codeB)), .unreadable),
            ("another amount", .success(CK.payment(.success, amountKobo: 999_900)), .unreadable),
            ("success that says no money moved", .success(CK.payment(.success, moneyMoved: false)), .unreadable),
            ("failure that says money moved", .success(CK.payment(.failed, reason: "x", moneyMoved: true)), .unreadable),
            ("pending that says money moved", .success(CK.payment(.pending, moneyMoved: true)), .unreadable),
        ]
        for (label, result, expected) in cases {
            #expect(verdict(result) == .unconfirmed(expected), "\(label)")
        }
    }

    @Test("a 429 carries its Retry-After into the verdict")
    func retryAfter() {
        let limited = APIError.server(ServerError(status: 429, code: .rate_limited, message: "Slow down.", retryAfterSeconds: 30))
        #expect(verdict(.failure(limited)) == .unconfirmed(.rateLimited(retryAfterSeconds: 30)))
    }
}

// MARK: - Confirming a started payment

@MainActor
@Suite("Checkout: a started payment is confirmed by verify")
struct CheckoutVerifyFlowTests {
    @Test("paid: the result is shown with the server's amount and reference, and the slot is MARKED settled, not removed")
    func paid() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        await rig.payAndStart(verify: .success(CK.paid))
        #expect(await waitUntil { rig.resultScreen != nil })
        #expect(rig.resultScreen == ResultScreen(
            code: CK.codeA, merchantName: "Adebayo Stores", title: "Ankara Two-Piece Set",
            amountKobo: 1_850_000, reference: CK.reference, result: .paid))
        #expect(rig.store.snapshot.count == 1)
        #expect(rig.store.snapshot.first?.settled == .paid)
        #expect(rig.service.verifies.map(\.reference) == [CK.reference])
    }

    @Test("verify is asked right after initialize answers, with the reference, and initialize is not asked again")
    func asksRightAway() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        let gate = Gate()
        await rig.payAndStart(verify: .success(CK.paid), gate: gate)
        #expect(rig.attemptScreen?.phase == .verifying(stillProcessing: false))
        #expect(await waitUntil { rig.service.verifies.count == 1 })
        #expect(rig.service.sends.count == 1)
        gate.open()
        #expect(await waitUntil { rig.resultScreen != nil })
        #expect(rig.service.sends.count == 1)
        #expect(rig.keys.made == 1)
    }

    /// Every outcome the server can decide, end to end.
    @Test("each decided outcome shows its result, marks the slot with it, and money moved only for paid", arguments: [
        ("paid", PaymentResult.paid),
        ("declined", .declined(reason: "Card declined by the simulated gateway.")),
        ("declined without a reason", .declined(reason: nil)),
        ("link disabled", .linkDisabled),
        ("link expired", .linkExpired),
        ("link already paid", .linkAlreadyPaid),
        ("link gone", .declined(reason: "Link no longer exists")),
        ("link_not_payable disabled", .linkDisabled),
        ("link_not_payable expired", .linkExpired),
        ("link_not_payable already paid", .linkAlreadyPaid),
        ("checkout not found", .checkoutNotFound),
    ])
    func decidedOutcomes(label: String, expected: PaymentResult) async {
        let answer: Result<VerifiedPayment, APIError>
        switch label {
        case "paid": answer = .success(CK.paid)
        case "declined": answer = .success(CK.declined)
        case "declined without a reason": answer = .success(CK.payment(.failed))
        case "link disabled": answer = .success(CK.payment(.failed, reason: "Link is disabled"))
        case "link expired": answer = .success(CK.payment(.failed, reason: "Link has expired"))
        case "link already paid": answer = .success(CK.payment(.failed, reason: "Link is already paid"))
        case "link gone": answer = .success(CK.payment(.failed, reason: "Link no longer exists"))
        case "link_not_payable disabled": answer = .failure(CK.refusal(.link_not_payable, status: 409, state: .disabled))
        case "link_not_payable expired": answer = .failure(CK.refusal(.link_not_payable, status: 409, state: .expired))
        case "link_not_payable already paid": answer = .failure(CK.refusal(.link_not_payable, status: 409, state: .already_hyphen_paid))
        default: answer = .failure(CK.refusal(.not_found, status: 404, message: "No checkout with that reference."))
        }
        let rig = CheckoutRig()
        await rig.openPayable()
        await rig.payAndStart(verify: answer)
        #expect(await waitUntil { rig.resultScreen != nil }, "\(label)")
        #expect(rig.resultScreen?.result == expected, "\(label)")
        #expect(rig.resultScreen?.result.moneyMoved == (expected == .paid), "\(label)")
        #expect(rig.store.snapshot.first?.settled == expected, "\(label)")
        #expect(rig.store.snapshot.first?.reference == CK.reference, "\(label)")
        // Nothing but the server's answer settled it: one initialize, one verify.
        #expect(rig.service.sends.count == 1, "\(label)")
        #expect(rig.service.verifies.count == 1, "\(label)")
    }

    @Test("a decided payment is shown as the server's amount, even when the link was open-amount")
    func openAmountResult() async {
        let rig = CheckoutRig()
        await rig.openPayable(amountKobo: nil)
        rig.fillForm(amount: "5000")
        rig.service.queueInitialize(.success(CK.started(amountKobo: 500_000)))
        rig.service.queueVerify(.success(CK.payment(.success, amountKobo: 500_000)))
        rig.controller.pay()
        #expect(await waitUntil { rig.resultScreen != nil })
        #expect(rig.resultScreen?.amountKobo == 500_000)
    }

    // MARK: Not decided

    @Test("every answer that does not decide it keeps the slot, says it could not confirm, and Check Again asks again with a fresh key", arguments: [
        "offline", "502", "500", "429", "302", "401", "unreadable", "validation", "mismatch", "other reference", "other amount",
    ])
    func undecidedKeepsTheSlot(label: String) async {
        let answer: Result<VerifiedPayment, APIError>
        let expected: Unconfirmed
        switch label {
        case "offline": (answer, expected) = (.failure(CK.offline), .noConnection)
        case "502": (answer, expected) = (.failure(.unexpectedResponse(status: 502)), .serverProblem)
        case "500": (answer, expected) = (.failure(CK.refusal(._internal, status: 500, moneyMoved: nil)), .serverProblem)
        case "429": (answer, expected) = (.failure(CK.refusal(.rate_limited, status: 429, moneyMoved: nil)), .rateLimited(retryAfterSeconds: nil))
        case "302": (answer, expected) = (.failure(.unexpectedResponse(status: 302)), .unreadable)
        case "401": (answer, expected) = (.failure(CK.refusal(.unauthenticated, status: 401, moneyMoved: nil)), .unreadable)
        case "unreadable": (answer, expected) = (.failure(.undecodableResponse), .unreadable)
        case "validation": (answer, expected) = (.failure(CK.refusal(.validation_failed, status: 400, message: "Bad.")), .refused(message: "Bad."))
        case "mismatch": (answer, expected) = (.failure(CK.refusal(.idempotency_mismatch, status: 422, message: "Key reused.")), .refused(message: "Key reused."))
        case "other reference": (answer, expected) = (.success(CK.payment(.success, reference: CK.otherReference)), .unreadable)
        default: (answer, expected) = (.success(CK.payment(.success, amountKobo: 999_900)), .unreadable)
        }
        let rig = CheckoutRig()
        await rig.openPayable()
        await rig.payAndStart(verify: answer)
        #expect(await waitUntil { rig.attemptScreen?.phase == .unconfirmed(expected) }, "\(label): \(rig.controller.screen)")
        // The slot is as the send left it: same key, reference known, NOT settled.
        #expect(rig.store.snapshot.count == 1, "\(label)")
        #expect(rig.store.snapshot.first?.settled == nil, "\(label)")
        #expect(rig.store.snapshot.first?.reference == CK.reference, "\(label)")
        #expect(rig.store.snapshot.first?.key == rig.service.sends.first?.key, "\(label)")
        // The form does not come back: Pay does nothing, and no second payment can be started under a new key.
        rig.controller.pay()
        #expect(rig.service.sends.count == 1, "\(label)")
        #expect(rig.keys.made == 1, "\(label)")
        #expect(rig.linkScreen == nil, "\(label)")

        // Check Again asks again, under a key of its own, and a decided answer ends it.
        rig.service.queueVerify(.success(CK.paid))
        rig.controller.checkAgain()
        #expect(rig.attemptScreen?.phase == .verifying(stillProcessing: false), "\(label)")
        #expect(await waitUntil { rig.resultScreen?.result == .paid }, "\(label)")
        let verifies = rig.service.verifies
        #expect(verifies.count == 2, "\(label)")
        #expect(Set(verifies.map(\.key)).count == 2, "\(label)")
        #expect(verifies.allSatisfy { $0.reference == CK.reference }, "\(label)")
        #expect(Set(verifies.map(\.key)).isDisjoint(with: rig.service.sends.map(\.key)), "\(label)")
        #expect(rig.service.sends.count == 1, "\(label)")
        #expect(rig.keys.made == 1, "\(label)")
        #expect(rig.verifyKeys.made == 2, "\(label)")
    }

    @Test("Check Again does nothing unless the payment is waiting for the person, and not while an ask is in the air")
    func checkAgainGuards() async {
        let idle = CheckoutRig()
        idle.controller.checkAgain()
        #expect(idle.service.verifies.isEmpty)

        let rig = CheckoutRig()
        await rig.openPayable()
        let gate = Gate()
        await rig.payAndStart(verify: .success(CK.paid), gate: gate)
        #expect(await waitUntil { rig.service.verifies.count == 1 })
        rig.controller.checkAgain()
        rig.controller.checkAgain()
        #expect(rig.service.verifies.count == 1)
        gate.open()
        #expect(await waitUntil { rig.resultScreen != nil })
        rig.controller.checkAgain()
        await rig.settle()
        #expect(rig.service.verifies.count == 1)
    }

    @Test("Check Again is not Try Again: an unknown send is retried by retry(), which never asks verify")
    func retryIsNotCheckAgain() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        rig.fillForm()
        rig.service.queueInitialize(.failure(CK.offline))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen?.phase == .unsettled(.noConnection) })
        rig.controller.checkAgain()
        #expect(rig.service.verifies.isEmpty)
        #expect(rig.attemptScreen?.phase == .unsettled(.noConnection))
    }

    @Test("an initialize that finally answers 201 on a retry goes on to verify, under the same initialize key")
    func retryThenVerify() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        rig.fillForm()
        rig.service.queueInitialize(.failure(CK.offline))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen?.phase == .unsettled(.noConnection) })
        rig.service.queueInitialize(.success(CK.started()))
        rig.service.queueVerify(.success(CK.paid))
        rig.controller.retry()
        #expect(await waitUntil { rig.resultScreen?.result == .paid })
        #expect(rig.service.sends.count == 2)
        #expect(Set(rig.service.sends.map(\.key)).count == 1)
        #expect(rig.keys.made == 1)
    }

    // MARK: Pending: bounded polling

    @Test("pending is re-asked after 2, 4 and 8 seconds and then waits for the person: three automatic checks, never a loop")
    func pendingIsBounded() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        await rig.payAndStart(verify: .success(CK.stillPending))
        #expect(await waitUntil { rig.attemptScreen?.phase == .verifying(stillProcessing: true) })
        #expect(await waitUntil { rig.sleeper.requested == [.seconds(2)] })
        #expect(rig.service.verifies.count == 1)

        for round in 1...3 {
            rig.service.queueVerify(.success(CK.stillPending))
            rig.sleeper.release()
            #expect(await waitUntil { rig.service.verifies.count == round + 1 }, "round \(round)")
            if round < 3 {
                #expect(await waitUntil { rig.sleeper.requested.count == round + 1 }, "round \(round)")
            }
        }
        #expect(rig.sleeper.requested == [.seconds(2), .seconds(4), .seconds(8)])
        #expect(await waitUntil { rig.attemptScreen?.phase == .unconfirmed(.stillProcessing) })
        // Four asks in all (the first and three re-asks), and it stops there.
        await rig.settle()
        rig.sleeper.release(5)
        await rig.settle()
        #expect(rig.service.verifies.count == 4)
        #expect(rig.sleeper.requested.count == 3)
        #expect(rig.store.snapshot.first?.settled == nil)
        #expect(rig.service.sends.count == 1)
    }

    @Test("a payment still processing after the automatic checks can be checked again by hand, which gets another bounded round")
    func manualCheckAfterPending() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        await rig.payAndStart(verify: .success(CK.stillPending))
        for _ in 1...3 {
            rig.service.queueVerify(.success(CK.stillPending))
            rig.sleeper.release()
            _ = await waitUntil { rig.sleeper.requested.count > 0 }
            await rig.settle()
        }
        #expect(await waitUntil { rig.attemptScreen?.phase == .unconfirmed(.stillProcessing) })

        rig.service.queueVerify(.success(CK.stillPending))
        rig.controller.checkAgain()
        #expect(await waitUntil { rig.attemptScreen?.phase == .verifying(stillProcessing: true) })
        rig.service.queueVerify(.success(CK.paid))
        rig.sleeper.release(10)
        #expect(await waitUntil { rig.resultScreen?.result == .paid })
    }

    @Test("pending that becomes paid ends on the result, and the waiting stops")
    func pendingThenPaid() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        await rig.payAndStart(verify: .success(CK.stillPending))
        #expect(await waitUntil { rig.sleeper.requested.count == 1 })
        rig.service.queueVerify(.success(CK.paid))
        rig.sleeper.release()
        #expect(await waitUntil { rig.resultScreen?.result == .paid })
        await rig.settle()
        #expect(rig.service.verifies.count == 2)
        #expect(rig.sleeper.requested.count == 1)
    }

    @Test("leaving the screen cancels the wait for the next automatic check")
    func leavingCancelsTheWait() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        await rig.payAndStart(verify: .success(CK.stillPending))
        #expect(await waitUntil { rig.sleeper.requested.count == 1 })
        rig.controller.close()
        #expect(await waitUntil { rig.sleeper.cancelled == 1 })
        rig.sleeper.release(5)
        await rig.settle()
        #expect(rig.service.verifies.count == 1)
    }

    @Test("opening another link cancels the wait, and so does starting over")
    func otherLinkCancelsTheWait() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        await rig.payAndStart(verify: .success(CK.stillPending))
        #expect(await waitUntil { rig.sleeper.requested.count == 1 })
        await rig.openPayable(CK.codeB)
        #expect(await waitUntil { rig.sleeper.cancelled == 1 })
        rig.sleeper.release(5)
        await rig.settle()
        #expect(rig.service.verifies.count == 1)

        let again = CheckoutRig()
        await again.openPayable()
        await again.payAndStart(verify: .success(CK.stillPending))
        #expect(await waitUntil { again.sleeper.requested.count == 1 })
        again.service.queueLookup(.success(CK.lookup()))
        again.controller.startOver()
        #expect(await waitUntil { again.sleeper.cancelled == 1 })
        again.sleeper.release(5)
        await again.settle()
        #expect(again.service.verifies.count == 1)
    }

    @Test("coming back while it waits does not stack a second ask on top of the first")
    func backWhileWaiting() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        let gate = Gate()
        await rig.payAndStart(verify: .success(CK.stillPending), gate: gate)
        #expect(await waitUntil { rig.service.verifies.count == 1 })
        rig.controller.open(CK.codeA)
        rig.controller.open(CK.codeA)
        #expect(rig.service.verifies.count == 1)
        #expect(rig.attemptScreen?.phase == .verifying(stillProcessing: false))
        gate.open()
        #expect(await waitUntil { rig.attemptScreen?.phase == .verifying(stillProcessing: true) })
        rig.controller.open(CK.codeA)
        #expect(rig.attemptScreen?.phase == .verifying(stillProcessing: true))
        #expect(rig.service.verifies.count == 1)
        #expect(rig.sleeper.requested.count == 1)
    }

    // MARK: Cold start, Back, and the screen

    @Test("a started payment found at launch is confirmed on opening, under a fresh verify key, with no initialize and no lookup")
    func relaunchStarted() async {
        let first = CheckoutRig()
        await first.openPayable()
        let gate = Gate()
        await first.payAndStart(verify: .success(CK.paid), gate: gate)
        #expect(first.store.snapshot.first?.reference == CK.reference)

        let cold = first.relaunched()
        cold.service.queueVerify(.success(CK.paid))
        cold.controller.open(CK.codeA)
        #expect(cold.attemptScreen?.phase == .verifying(stillProcessing: false))
        #expect(cold.attemptScreen?.reference == CK.reference)
        #expect(await waitUntil { cold.resultScreen?.result == .paid })
        #expect(cold.service.sends.isEmpty)
        #expect(cold.service.lookups.isEmpty)
        #expect(cold.keys.made == 0)
        gate.open()
    }

    @Test("a decided payment comes back from the Keychain after a relaunch with NO network call, until it is dismissed")
    func relaunchSettled() async {
        let first = CheckoutRig()
        await first.openPayable()
        await first.payAndStart(verify: .success(CK.paid))
        #expect(await waitUntil { first.resultScreen != nil })

        let cold = first.relaunched()
        cold.controller.open(CK.codeA)
        #expect(cold.resultScreen == first.resultScreen)
        #expect(cold.service.verifies.isEmpty)
        #expect(cold.service.lookups.isEmpty)
        #expect(cold.service.sends.isEmpty)

        cold.controller.close()
        #expect(cold.store.snapshot.isEmpty)
        let afterwards = cold.relaunched()
        afterwards.service.queueLookup(.success(CK.lookup()))
        afterwards.controller.open(CK.codeA)
        #expect(await waitUntil { afterwards.linkScreen != nil })
        #expect(afterwards.service.verifies.isEmpty)
    }

    @Test("Back and re-tap on a result shows it again; Back and re-tap on an unconfirmed payment asks again")
    func backAndReopen() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        await rig.payAndStart(verify: .success(CK.paid))
        #expect(await waitUntil { rig.resultScreen != nil })
        let before = rig.resultScreen
        // The reopening below happens WITHOUT close(): the navigation stack re-announces the same link.
        rig.controller.open(CK.codeA)
        #expect(rig.resultScreen == before)
        #expect(rig.service.verifies.count == 1)

        let other = CheckoutRig()
        await other.openPayable()
        await other.payAndStart(verify: .failure(CK.offline))
        #expect(await waitUntil { other.attemptScreen?.phase == .startedUnverified })
        other.controller.close()
        other.service.queueVerify(.success(CK.declined))
        other.controller.open(CK.codeA)
        #expect(await waitUntil { other.resultScreen != nil })
        #expect(other.service.verifies.count == 2)
        #expect(other.service.lookups.count == 1)
    }

    // MARK: The answer arrives after the person left

    @Test("a decided answer that arrives after Back is written to the slot, and the next open shows it with no second ask")
    func answerAfterBack() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        let gate = Gate()
        await rig.payAndStart(verify: .success(CK.paid), gate: gate)
        #expect(await waitUntil { rig.service.verifies.count == 1 })
        rig.controller.close()
        #expect(rig.controller.screen == .idle)
        gate.open()
        #expect(await waitUntil { rig.store.snapshot.first?.settled == .paid })
        #expect(rig.controller.screen == .idle)

        rig.controller.open(CK.codeA)
        #expect(rig.resultScreen?.result == .paid)
        #expect(rig.service.verifies.count == 1)
    }

    @Test("a decided answer for link A does not touch the screen of link B, and the person does not lose it")
    func answerWhileOnAnotherLink() async {
        let rig = CheckoutRig()
        await rig.openPayable(CK.codeA)
        let gate = Gate()
        await rig.payAndStart(verify: .success(CK.paid), gate: gate)
        #expect(await waitUntil { rig.service.verifies.count == 1 })
        await rig.openPayable(CK.codeB, amountKobo: nil)
        gate.open()
        #expect(await waitUntil { rig.store.snapshot.first?.settled == .paid })
        #expect(rig.linkScreen?.link.code == CK.codeB)
        #expect(rig.resultScreen == nil)
        rig.controller.open(CK.codeA)
        #expect(rig.resultScreen?.code == CK.codeA)
    }

    @Test("the person leaving mid-ask does not cancel it: the request is not tied to the screen")
    func leavingDoesNotCancelTheRequest() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        let gate = Gate()
        await rig.payAndStart(verify: .success(CK.paid), gate: gate)
        #expect(await waitUntil { rig.service.verifies.count == 1 })
        rig.controller.close()
        gate.open()
        #expect(await waitUntil { rig.store.snapshot.first?.settled == .paid })
    }

    @Test("an answer that arrives after a sign-out removed the attempt is dropped: it cannot bring the slot back")
    func answerAfterSignOut() async {
        let rig = CheckoutRig(owner: .session(userID: CK.userOne.id))
        rig.controller.sessionDidChange(.resolved(CK.userOne))
        await rig.openPayable()
        let gate = Gate()
        await rig.payAndStart(verify: .success(CK.paid), gate: gate)
        #expect(await waitUntil { rig.service.verifies.count == 1 })
        #expect(rig.controller.prepareSignOut())
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.sessionDidChange(.signedOutByChoice)
        #expect(rig.store.snapshot.isEmpty)
        gate.open()
        await rig.settle()
        #expect(rig.store.snapshot.isEmpty)
        #expect(rig.resultScreen == nil)
    }

    @Test("a late answer for an older attempt (another key) changes neither the screen nor the slot")
    func staleAnswerForOlderAttempt() async throws {
        let rig = CheckoutRig()
        await rig.openPayable()
        await rig.payAndStart(verify: .success(CK.declined))
        #expect(await waitUntil { rig.resultScreen != nil })
        let old = try #require(rig.store.snapshot.first)
        // A new payment replaces it.
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.startOver()
        #expect(await waitUntil { rig.linkScreen != nil })
        rig.fillForm()
        rig.service.queueInitialize(.success(CK.started(reference: CK.otherReference)))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen?.reference == CK.otherReference })
        await rig.settle()
        let screen = rig.controller.screen
        let stored = rig.store.snapshot

        rig.controller.applyVerify(.success(CK.paid), context: .init(pending: old, reference: CK.reference))
        #expect(rig.controller.screen == screen)
        #expect(rig.store.snapshot == stored)
    }

    @Test("a late 'could not confirm' never takes back a result that has arrived")
    func lateUnconfirmedDoesNotDowngrade() async throws {
        let rig = CheckoutRig()
        await rig.openPayable()
        await rig.payAndStart(verify: .success(CK.paid))
        #expect(await waitUntil { rig.resultScreen != nil })
        let stored = try #require(rig.store.snapshot.first)
        rig.controller.applyVerify(.failure(CK.offline), context: .init(pending: stored, reference: CK.reference))
        rig.controller.applyVerify(.success(CK.stillPending), context: .init(pending: stored, reference: CK.reference))
        #expect(rig.resultScreen?.result == .paid)
        #expect(rig.store.snapshot.first?.settled == .paid)
        #expect(rig.sleeper.requested.isEmpty)
    }

    @Test("a decided answer is not applied to the screen of an attempt the person has started over")
    func answerAfterStartOver() async throws {
        let rig = CheckoutRig()
        await rig.openPayable()
        await rig.payAndStart(verify: .failure(CK.offline))
        #expect(await waitUntil { rig.attemptScreen?.phase == .startedUnverified })
        let old = try #require(rig.store.snapshot.first)
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.startOver()
        #expect(await waitUntil { rig.linkScreen != nil })
        rig.controller.applyVerify(.success(CK.paid), context: .init(pending: old, reference: CK.reference))
        #expect(rig.linkScreen != nil)
        #expect(rig.store.snapshot.isEmpty)
    }

    @Test("start over does nothing while an ask is in the air")
    func startOverWhileVerifying() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        let gate = Gate()
        await rig.payAndStart(verify: .success(CK.paid), gate: gate)
        #expect(await waitUntil { rig.service.verifies.count == 1 })
        rig.controller.startOver()
        #expect(rig.store.snapshot.count == 1)
        #expect(rig.attemptScreen != nil)
        gate.open()
        #expect(await waitUntil { rig.resultScreen != nil })
    }

    // MARK: Storage

    @Test("if the result cannot be written down, it is still shown, and a relaunch asks again and gets the same answer")
    func settleWriteFails() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        let gate = Gate()
        await rig.payAndStart(verify: .success(CK.paid), gate: gate)
        #expect(await waitUntil { rig.service.verifies.count == 1 })
        rig.store.fail(.write)
        gate.open()
        #expect(await waitUntil { rig.resultScreen?.result == .paid })
        #expect(rig.store.snapshot.first?.settled == nil)
        #expect(rig.store.snapshot.first?.reference == CK.reference)

        rig.store.heal()
        let cold = rig.relaunched()
        cold.service.queueVerify(.success(CK.paid))
        cold.controller.open(CK.codeA)
        #expect(await waitUntil { cold.resultScreen?.result == .paid })
        #expect(cold.service.verifies.count == 1)
        #expect(cold.service.sends.isEmpty)
    }

    @Test("a slot that cannot be read while an answer arrives does not stop the answer reaching the screen")
    func settleReadFails() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        let gate = Gate()
        await rig.payAndStart(verify: .success(CK.paid), gate: gate)
        #expect(await waitUntil { rig.service.verifies.count == 1 })
        rig.store.fail(.read)
        gate.open()
        #expect(await waitUntil { rig.resultScreen?.result == .paid })
        #expect(rig.store.snapshot.first?.settled == nil)
    }
}

// MARK: - Dismissing a result, and Try Again

@MainActor
@Suite("Checkout: a finished payment is forgotten when it has been seen, not before")
struct CheckoutResultDismissalTests {
    private func finished(_ answer: Result<VerifiedPayment, APIError> = .success(CK.paid)) async -> CheckoutRig {
        let rig = CheckoutRig()
        await rig.openPayable()
        await rig.payAndStart(verify: answer)
        _ = await waitUntil { rig.resultScreen != nil }
        return rig
    }

    @Test("Back (close) removes it; a removal that fails leaves it, and it is shown again rather than lost")
    func closeRemoves() async {
        let rig = await finished()
        rig.store.fail(.remove)
        rig.controller.close()
        #expect(rig.store.snapshot.count == 1)
        rig.controller.open(CK.codeA)
        #expect(rig.resultScreen?.result == .paid)
        rig.store.heal()
        rig.controller.close()
        #expect(rig.store.snapshot.isEmpty)
    }

    @Test("opening another link removes the finished payment of the first")
    func otherLinkRemoves() async {
        let rig = await finished()
        await rig.openPayable(CK.codeB, amountKobo: nil)
        #expect(rig.store.snapshot.isEmpty)
        #expect(rig.linkScreen?.link.code == CK.codeB)
    }

    @Test("an unconfirmed payment is NOT removed by Back: only a decided one that was shown is")
    func unconfirmedSurvivesBack() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        await rig.payAndStart(verify: .failure(CK.offline))
        #expect(await waitUntil { rig.attemptScreen?.phase == .startedUnverified })
        rig.controller.close()
        #expect(rig.store.snapshot.count == 1)
        #expect(rig.store.snapshot.first?.reference == CK.reference)
    }

    @Test("Try Again on a payment that did not go through removes it, reads the link afresh and opens an EMPTY form under a NEW key")
    func tryAgain() async {
        let rig = await finished(.success(CK.declined))
        #expect(rig.resultScreen?.result == .declined(reason: "Card declined by the simulated gateway."))
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.startOver()
        #expect(await waitUntil { rig.linkScreen != nil })
        #expect(rig.store.snapshot.isEmpty)
        #expect(rig.controller.form.isEmpty)
        #expect(rig.service.lookups.count == 2)

        rig.fillForm()
        rig.service.queueInitialize(.success(CK.started(reference: CK.otherReference)))
        rig.service.queueVerify(.success(CK.payment(.success, reference: CK.otherReference)))
        rig.controller.pay()
        #expect(await waitUntil { rig.resultScreen?.result == .paid })
        #expect(rig.keys.made == 2)
        #expect(Set(rig.service.sends.map(\.key)).count == 2)
        #expect(rig.service.verifies.map(\.reference) == [CK.reference, CK.otherReference])
    }

    @Test("Try Again works after every outcome that moved no money, and a paid payment cannot be started over")
    func tryAgainEachOutcome() async {
        let answers: [Result<VerifiedPayment, APIError>] = [
            .success(CK.payment(.failed, reason: "Link has expired")),
            .success(CK.payment(.failed, reason: "Link is disabled")),
            .success(CK.payment(.failed, reason: "Link is already paid")),
            .failure(CK.refusal(.not_found, status: 404)),
        ]
        for answer in answers {
            let rig = await finished(answer)
            #expect(rig.resultScreen != nil)
            rig.service.queueLookup(.success(CK.lookup(availability: .expired)))
            rig.controller.startOver()
            #expect(await waitUntil { rig.linkScreen != nil })
            #expect(rig.store.snapshot.isEmpty)
        }
        let paid = await finished(.success(CK.paid))
        paid.controller.startOver()
        #expect(paid.resultScreen?.result == .paid)
        #expect(paid.store.snapshot.count == 1)
        #expect(paid.service.lookups.count == 1)
    }

    @Test("if the Keychain will not let go, Try Again changes nothing and says so; it works once the Keychain does")
    func tryAgainFails() async {
        let rig = await finished(.success(CK.declined))
        rig.store.fail(.remove)
        let before = rig.resultScreen
        rig.controller.startOver()
        #expect(rig.resultScreen?.actionFailed == true)
        var unchanged = rig.resultScreen
        unchanged?.actionFailed = false
        #expect(unchanged == before)
        #expect(rig.store.snapshot.count == 1)
        #expect(rig.service.lookups.count == 1)
        rig.store.heal()
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.startOver()
        #expect(await waitUntil { rig.linkScreen != nil })
        #expect(rig.store.snapshot.isEmpty)
    }

    @Test("a reusable link cannot be paid twice until verify has settled the first: unconfirmed has no form")
    func noSecondPaymentBeforeSettlement() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        await rig.payAndStart(verify: .failure(.unexpectedResponse(status: 503)))
        #expect(await waitUntil { rig.attemptScreen?.phase == .unconfirmed(.serverProblem) })
        rig.controller.close()
        rig.controller.open(CK.codeA)
        #expect(rig.linkScreen == nil)
        rig.fillForm()
        rig.controller.pay()
        #expect(rig.service.sends.count == 1)
        #expect(rig.keys.made == 1)
    }

    @Test("sign-out: a finished payment is removed with the session, but does not trigger the unfinished-payment warning")
    func signOut() async {
        let rig = CheckoutRig(owner: .session(userID: CK.userOne.id))
        rig.controller.sessionDidChange(.resolved(CK.userOne))
        await rig.openPayable()
        await rig.payAndStart(verify: .failure(CK.offline))
        #expect(await waitUntil { rig.attemptScreen?.phase == .startedUnverified })
        #expect(rig.controller.hasSessionAttempts)
        rig.service.queueVerify(.success(CK.paid))
        rig.controller.checkAgain()
        #expect(await waitUntil { rig.resultScreen != nil })
        #expect(!rig.controller.hasSessionAttempts)
        #expect(rig.controller.prepareSignOut())
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.sessionDidChange(.signedOutByChoice)
        #expect(rig.store.snapshot.isEmpty)
        #expect(await waitUntil { rig.linkScreen != nil })
    }
}

// MARK: - Privacy

@MainActor
@Suite("Checkout results: a payer's name and email are never on a screen")
struct CheckoutResultPrivacyTests {
    /// Everything the screen is made of. (The form still holds what was typed until the link is closed or started
    /// over, as in I3; it is not on screen while a payment exists, and Try Again resets it.)
    private func shown(_ rig: CheckoutRig) -> String {
        String(describing: rig.controller.screen)
    }

    @Test("verifying, unconfirmed, still processing and every result carry no name or email")
    func noDetailsInAnyState() async {
        let answers: [Result<VerifiedPayment, APIError>] = [
            .success(CK.paid), .success(CK.declined), .success(CK.payment(.failed, reason: "Link has expired")),
            .failure(CK.refusal(.not_found, status: 404)), .failure(CK.offline), .success(CK.stillPending),
        ]
        for answer in answers {
            let rig = CheckoutRig()
            await rig.openPayable()
            let gate = Gate()
            await rig.payAndStart(verify: answer, gate: gate)
            let waiting = shown(rig)
            #expect(!waiting.contains("Ngozi") && !waiting.contains("Okafor") && !waiting.contains("ngozi@example.test"), "verifying")
            gate.open()
            _ = await waitUntil { rig.resultScreen != nil || rig.attemptScreen?.phase != .verifying(stillProcessing: false) }
            await rig.settle()
            let text = shown(rig)
            #expect(!text.contains("Ngozi") && !text.contains("Okafor") && !text.contains("ngozi@example.test"), "\(answer)")
            // ... and after a relaunch, and after Try Again opens a form.
            let cold = rig.relaunched()
            cold.controller.open(CK.codeA)
            let coldText = shown(cold)
            #expect(!coldText.contains("Ngozi") && !coldText.contains("Okafor") && !coldText.contains("ngozi@example.test"), "cold \(answer)")
        }
    }

    @Test("the types a result is made of have no place for a name or an email")
    func typesHaveNoPayerFields() {
        let screen = ResultScreen(code: CK.codeA, merchantName: "m", title: "t", amountKobo: 1, reference: CK.reference, result: .paid)
        #expect(Set(Mirror(reflecting: screen).children.compactMap(\.label)) == ["code", "merchantName", "title", "amountKobo", "reference", "result", "actionFailed"])
        let payment = Mirror(reflecting: CK.paid).children.compactMap(\.label)
        #expect(Set(payment) == ["reference", "code", "amountKobo", "status", "moneyMoved", "failureReason"])
    }

    @Test("Try Again opens an empty form, and a stored name and email are not in it")
    func tryAgainFormIsEmpty() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        await rig.payAndStart(verify: .success(CK.declined))
        #expect(await waitUntil { rig.resultScreen != nil })
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.startOver()
        #expect(await waitUntil { rig.linkScreen != nil })
        #expect(rig.controller.form.isEmpty)
    }
}
