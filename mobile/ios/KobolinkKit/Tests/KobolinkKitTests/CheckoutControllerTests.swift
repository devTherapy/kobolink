import Foundation
import Testing

@testable import KobolinkKit

/// A value a `@Sendable` closure can write and a test can read.
final class Captured<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: T
    init(_ initial: T) { stored = initial }
    var value: T {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); defer { lock.unlock() }; stored = newValue }
    }
}

// MARK: - Paying

@MainActor
@Suite("Checkout: opening, paying, the form")
struct CheckoutPayTests {
    @Test("opening a link looks it up and shows a payable link with an empty form")
    func opensPayable() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        #expect(rig.service.lookups == [CK.codeA])
        #expect(rig.linkScreen == LinkScreen(link: CK.link(), availability: .payable, pay: .editing))
        #expect(rig.controller.form.isEmpty)
    }

    @Test("the screen is a skeleton while the lookup is in flight")
    func loadingWhileLooking() async {
        let rig = CheckoutRig()
        let gate = Gate()
        rig.service.queueLookup(.success(CK.lookup()), gate: gate)
        rig.controller.open(CK.codeA)
        #expect(rig.controller.screen == .loading(CK.codeA))
        gate.open()
        #expect(await waitUntil { rig.linkScreen != nil })
    }

    @Test("each non-payable state shows its link with that state, and Pay does nothing")
    func nonPayable() async {
        for availability in [LinkAvailability.disabled, .expired, .alreadyPaid] {
            let rig = CheckoutRig()
            rig.service.queueLookup(.success(CK.lookup(availability: availability)))
            rig.controller.open(CK.codeA)
            #expect(await waitUntil { rig.linkScreen?.availability == availability })
            rig.fillForm()
            rig.controller.pay()
            #expect(rig.service.sends.isEmpty)
        }
    }

    @Test("a parsed not_found is the not-found screen; any other failure is load-failed with what happened")
    func lookupFailures() async {
        let cases: [(APIError, CheckoutScreen)] = [
            (CK.notFound, .notFound(CK.codeA)),
            (CK.offline, .loadFailed(CK.codeA, .noConnection)),
            (.unexpectedResponse(status: 502), .loadFailed(CK.codeA, .serverProblem)),
            (.unexpectedResponse(status: 404), .loadFailed(CK.codeA, .unreadable)),
            (.undecodableResponse, .loadFailed(CK.codeA, .unreadable)),
            (CK.refusal(.rate_limited, status: 429, moneyMoved: nil), .loadFailed(CK.codeA, .rateLimited(retryAfterSeconds: nil))),
            (CK.refusal(._internal, status: 500, moneyMoved: nil), .loadFailed(CK.codeA, .serverProblem)),
        ]
        for (error, expected) in cases {
            let rig = CheckoutRig()
            rig.service.queueLookup(.failure(error))
            rig.controller.open(CK.codeA)
            #expect(await waitUntil { rig.controller.screen == expected }, "\(error) should show \(expected), shows \(rig.controller.screen)")
        }
    }

    @Test("a not_found from an HTML 404 page is a failed load, not 'this link does not exist'")
    func htmlNotFoundIsNotNotFound() async {
        let rig = CheckoutRig()
        rig.service.queueLookup(.failure(.unexpectedResponse(status: 404)))
        rig.controller.open(CK.codeA)
        #expect(await waitUntil { rig.controller.screen == .loadFailed(CK.codeA, .unreadable) })
    }

    @Test("Try Again on a failed load looks the link up again")
    func reloadAfterFailure() async {
        let rig = CheckoutRig()
        rig.service.queueLookup(.failure(CK.offline))
        rig.controller.open(CK.codeA)
        #expect(await waitUntil { rig.controller.screen == .loadFailed(CK.codeA, .noConnection) })
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.reload()
        #expect(await waitUntil { rig.linkScreen != nil })
        #expect(rig.service.lookups == [CK.codeA, CK.codeA])
    }

    @Test("a fixed-amount link sends the link's amount whatever is in the amount field")
    func fixedAmount() async {
        let rig = CheckoutRig()
        await rig.openPayable(amountKobo: 1_850_000)
        rig.fillForm(amount: "1")
        rig.service.queueInitialize(.success(CK.started()))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen != nil })
        #expect(rig.service.sends.first?.request == CK.request(amountKobo: 1_850_000))
    }

    @Test("an open-amount link sends the typed amount as integer kobo")
    func openAmount() async {
        let rig = CheckoutRig()
        await rig.openPayable(amountKobo: nil)
        rig.fillForm(amount: "₦5,000.50")
        rig.service.queueInitialize(.success(CK.started(amountKobo: 500_050)))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen != nil })
        #expect(rig.service.sends.first?.request.amountKobo == 500_050)
    }

    @Test("invalid fields send nothing and put an error beside each")
    func inlineValidation() async {
        let rig = CheckoutRig()
        await rig.openPayable(amountKobo: nil)
        rig.fillForm(name: "  ", email: "nope", amount: "5")
        rig.controller.pay()
        #expect(rig.service.sends.isEmpty)
        #expect(rig.store.snapshot.isEmpty)
        #expect(rig.controller.form.errors[.name] == "Enter your name.")
        #expect(rig.controller.form.errors[.email] == "Enter a valid email address.")
        #expect(rig.controller.form.errors[.amount] == "Enter an amount between ₦100 and ₦10,000,000.")
        rig.controller.form.edited(.name)
        #expect(rig.controller.form.errors[.name] == nil)
    }

    @Test("leaving a field checks that field, and an untouched empty one is left alone")
    func fieldOnBlur() {
        let rig = CheckoutRig()
        rig.controller.form.email = "nope"
        rig.controller.form.left(.email)
        #expect(rig.controller.form.errors[.email] == "Enter a valid email address.")
        rig.controller.form.left(.name)
        #expect(rig.controller.form.errors[.name] == nil)
    }

    @Test("the name and email are sent trimmed, and the email lower-cased, as the server will read them")
    func normalisedRequest() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        rig.fillForm(name: "  Ngozi Okafor \n", email: " NGOZI@Example.TEST ")
        rig.service.queueInitialize(.success(CK.started()))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen != nil })
        #expect(rig.service.sends.first?.request == CK.request(name: "Ngozi Okafor", email: "ngozi@example.test"))
    }

    @Test("a double tap on Pay is one request")
    func doubleTap() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        rig.fillForm()
        let gate = Gate()
        rig.service.queueInitialize(.success(CK.started()), gate: gate)
        rig.controller.pay()
        rig.controller.pay()
        #expect(rig.linkScreen?.pay == .submitting)
        gate.open()
        #expect(await waitUntil { rig.attemptScreen != nil })
        #expect(rig.service.sends.count == 1)
        #expect(rig.keys.made == 1)
    }

    @Test("201 is 'Payment started' with the server's reference and amount")
    func started() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        rig.fillForm()
        rig.service.queueInitialize(.success(CK.started()))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen?.phase == .started })
        #expect(rig.attemptScreen == AttemptScreen(
            code: CK.codeA, merchantName: "Adebayo Stores", title: "Ankara Two-Piece Set",
            amountKobo: 1_850_000, reference: CK.reference, phase: .started))
    }

    @Test("a reply about another payment is not 'Payment started'")
    func wrongReply() async {
        for reply in [CK.started(CK.codeB), CK.started(amountKobo: 999_900)] {
            let rig = CheckoutRig()
            await rig.openPayable()
            rig.fillForm()
            rig.service.queueInitialize(.success(reply))
            rig.controller.pay()
            #expect(await waitUntil { rig.attemptScreen?.phase == .unsettled(.unreadable) })
            #expect(rig.attemptScreen?.reference == nil)
        }
    }
}

// MARK: - Lesson 1 and 6: never a new key while the outcome is unknown; no silent retry

@MainActor
@Suite("Checkout: an attempt of unknown outcome keeps its key")
struct CheckoutKeyTests {
    private func unsettledRig() async -> CheckoutRig {
        let rig = CheckoutRig()
        await rig.openPayable()
        rig.fillForm()
        rig.service.queueInitialize(.failure(CK.offline))
        rig.controller.pay()
        _ = await waitUntil { rig.attemptScreen?.phase == .unsettled(.noConnection) }
        return rig
    }

    @Test("a dropped connection is an unknown outcome, said as one: not 'no money was taken'")
    func droppedConnection() async {
        let rig = await unsettledRig()
        #expect(rig.attemptScreen?.phase == .unsettled(.noConnection))
        let words = [CheckoutCopy.unsettledHeading, CheckoutCopy.unsettledBody(.noConnection), CheckoutCopy.unsettledStatus, CheckoutCopy.unsettledNextStep(merchant: "Adebayo Stores")]
            .joined(separator: " ")
        #expect(words.contains("couldn't confirm"))
        #expect(words.contains("before paying again"))
        #expect(!words.lowercased().contains("no money"))
    }

    @Test("a retry resends the same request under the same key, and no new key is made")
    func retrySameKey() async {
        let rig = await unsettledRig()
        rig.service.queueInitialize(.success(CK.started()))
        rig.controller.retry()
        #expect(await waitUntil { rig.attemptScreen?.phase == .started })
        let sends = rig.service.sends
        #expect(sends.count == 2)
        #expect(sends[0] == sends[1])
        #expect(rig.keys.made == 1)
    }

    @Test("the form is not on screen while an unknown attempt exists, so its request cannot be edited under the old key")
    func formGone() async {
        let rig = await unsettledRig()
        #expect(rig.linkScreen == nil)
        rig.controller.pay()
        #expect(rig.service.sends.count == 1)
    }

    @Test("every retry sends exactly one request: no hidden resend")
    func oneRequestPerRetry() async {
        let rig = await unsettledRig()
        for expected in 2...4 {
            rig.service.queueInitialize(.failure(.unexpectedResponse(status: 503)))
            rig.controller.retry()
            #expect(await waitUntil { rig.attemptScreen?.phase == .unsettled(.serverProblem) })
            await rig.settle()
            #expect(rig.service.sends.count == expected)
        }
        #expect(Set(rig.service.sends.map(\.key)).count == 1)
    }

    @Test("a retry while one is in flight is ignored")
    func retryWhileSending() async {
        let rig = await unsettledRig()
        let gate = Gate()
        rig.service.queueInitialize(.failure(CK.offline), gate: gate)
        rig.controller.retry()
        rig.controller.retry()
        #expect(rig.attemptScreen?.phase == .sending)
        gate.open()
        #expect(await waitUntil { rig.attemptScreen?.phase == .unsettled(.noConnection) })
        #expect(rig.service.sends.count == 2)
    }

    @Test("a process kill and relaunch shows the interrupted attempt and retries the SAME key")
    func relaunchRetry() async {
        let rig = await unsettledRig()
        let again = rig.relaunched()
        again.controller.open(CK.codeA)
        #expect(again.attemptScreen?.phase == .unsettled(.interrupted))
        #expect(again.service.lookups.isEmpty)
        again.service.queueInitialize(.success(CK.started()))
        again.controller.retry()
        #expect(await waitUntil { again.attemptScreen?.phase == .started })
        #expect(again.service.sends.first == rig.service.sends.first)
        #expect(again.keys.made == 0)
    }

    @Test("Back and re-tap keep the attempt: the form does not come back with a new key")
    func backAndReopen() async {
        let rig = await unsettledRig()
        rig.controller.close()
        rig.controller.open(CK.codeA)
        #expect(rig.attemptScreen?.phase == .unsettled(.interrupted))
        #expect(rig.service.lookups == [CK.codeA])
        rig.service.queueInitialize(.success(CK.started()))
        rig.controller.retry()
        #expect(await waitUntil { rig.attemptScreen?.phase == .started })
        #expect(rig.keys.made == 1)
    }

    @Test("a refusal that only applies to a replay does not settle it: it stays, with the same key")
    func replayRefusalKeepsAttempt() async {
        let refusals: [APIError] = [
            CK.refusal(.validation_failed, status: 400, moneyMoved: nil, fields: ["payerEmail": ["Invalid"]]),
            CK.refusal(.validation_failed, status: 400, moneyMoved: false),
            CK.refusal(.unauthenticated, status: 401, moneyMoved: nil),
            CK.refusal(.forbidden, status: 403, moneyMoved: nil),
            CK.refusal(.idempotency_mismatch, status: 422),
            CK.refusal(.conflict, status: 409, moneyMoved: nil),
            CK.refusal(.insufficient_funds, status: 422),
            CK.refusal(.rate_limited, status: 429, moneyMoved: nil),
            CK.refusal(._internal, status: 500, moneyMoved: nil),
            // The three settling codes, but without the server saying nothing moved, or on the wrong status.
            CK.refusal(.link_not_payable, status: 409, moneyMoved: nil),
            CK.refusal(.amount_mismatch, status: 422, moneyMoved: nil),
            CK.refusal(.not_found, status: 404, moneyMoved: nil),
            CK.refusal(.not_found, status: 400),
            .unexpectedResponse(status: 401),
            .unexpectedResponse(status: 302),
            .undecodableResponse,
        ]
        for refusal in refusals {
            let rig = await unsettledRig()
            rig.service.queueInitialize(.failure(refusal))
            rig.controller.retry()
            #expect(await waitUntil { if case .unsettled = rig.attemptScreen?.phase { true } else { false } }, "\(refusal)")
            #expect(rig.store.snapshot.count == 1, "\(refusal) removed the attempt")
            #expect(rig.store.snapshot.first?.key == rig.service.sends.first?.key)
            // ... and the next retry still reuses the key.
            rig.service.queueInitialize(.success(CK.started()))
            rig.controller.retry()
            #expect(await waitUntil { rig.attemptScreen?.phase == .started })
            #expect(Set(rig.service.sends.map(\.key)).count == 1, "\(refusal)")
            #expect(rig.keys.made == 1)
        }
    }

    @Test("an unreadable attempt (no connection) on the very first send is an unknown outcome too")
    func firstSendUnknown() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        rig.fillForm()
        let refusals: [APIError] = [CK.refusal(.rate_limited, status: 429, moneyMoved: nil), .unexpectedResponse(status: 502), CK.refusal(.idempotency_mismatch, status: 422)]
        rig.service.queueInitialize(.failure(refusals[0]))
        rig.controller.pay()
        #expect(await waitUntil { if case .unsettled = rig.attemptScreen?.phase { true } else { false } })
        #expect(rig.store.snapshot.count == 1)
    }
}

// MARK: - Lesson 3: when the slot is cleared

@MainActor
@Suite("Checkout: when an attempt ends")
struct CheckoutClearingTests {
    private func sentRig(amountKobo: Int? = 1_850_000) async -> CheckoutRig {
        let rig = CheckoutRig()
        await rig.openPayable(amountKobo: amountKobo)
        rig.fillForm(amount: amountKobo == nil ? "5000" : "")
        return rig
    }

    @Test("not_found, link_not_payable and amount_mismatch (moneyMoved false) end the attempt and leave no slot")
    func settledRefusalsClear() async {
        for (error, expectation) in [
            (CK.notFound, "notFound"), (CK.linkNotPayable, "disabled"), (CK.amountMismatch, "priceChanged"),
        ] {
            let rig = await sentRig()
            rig.service.queueInitialize(.failure(error))
            switch expectation {
            case "disabled": rig.service.queueLookup(.success(CK.lookup(availability: .disabled)))
            case "priceChanged": rig.service.queueLookup(.success(CK.lookup(amountKobo: 2_000_000)))
            default: break
            }
            rig.controller.pay()
            switch expectation {
            case "notFound":
                #expect(await waitUntil { rig.controller.screen == .notFound(CK.codeA) })
            case "disabled":
                #expect(await waitUntil { rig.linkScreen?.availability == .disabled })
                #expect(rig.linkScreen?.pay == .editing)
            default:
                #expect(await waitUntil { rig.linkScreen?.pay == .priceChanged(newAmountKobo: 2_000_000) })
                #expect(rig.linkScreen?.link.amountKobo == 2_000_000)
            }
            #expect(rig.store.snapshot.isEmpty, "\(expectation) left a slot behind")
        }
    }

    @Test("after a settled refusal the link is READ AGAIN before a new key is made, and the new key is new")
    func newKeyOnlyAfterFreshRead() async {
        let rig = await sentRig()
        rig.service.queueInitialize(.failure(CK.amountMismatch))
        let gate = Gate()
        rig.service.queueLookup(.success(CK.lookup(amountKobo: 2_000_000)), gate: gate)
        rig.controller.pay()
        #expect(await waitUntil { rig.controller.screen == .loading(CK.codeA) })
        // While the read is in flight there is no form to pay from.
        rig.controller.pay()
        #expect(rig.service.sends.count == 1)
        #expect(rig.keys.made == 1)
        gate.open()
        #expect(await waitUntil { rig.linkScreen?.pay == .priceChanged(newAmountKobo: 2_000_000) })
        rig.service.queueInitialize(.success(CK.started(amountKobo: 2_000_000)))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen?.phase == .started })
        let sends = rig.service.sends
        #expect(sends.count == 2)
        #expect(sends[0].key != sends[1].key)
        #expect(sends[1].request.amountKobo == 2_000_000)
        #expect(rig.service.lookups.count == 2)
    }

    @Test("if the fresh read after a refused price fails, there is no Pay: the refused amount is never offered again")
    func priceReadFails() async {
        let rig = await sentRig()
        rig.service.queueInitialize(.failure(CK.amountMismatch))
        rig.service.queueLookup(.failure(CK.offline))
        rig.controller.pay()
        #expect(await waitUntil { rig.controller.screen == .loadFailed(CK.codeA, .noConnection) })
        rig.controller.pay()
        #expect(rig.service.sends.count == 1)
        // Try again, and the notice about the price still arrives with the fresh read.
        rig.service.queueLookup(.success(CK.lookup(amountKobo: 2_000_000)))
        rig.controller.reload()
        #expect(await waitUntil { rig.linkScreen?.pay == .priceChanged(newAmountKobo: 2_000_000) })
    }

    @Test("a validation refusal on the FIRST send ends the attempt: the form stays, with the server's field errors")
    func firstSendValidation() async {
        let rig = await sentRig()
        rig.service.queueInitialize(.failure(CK.refusal(
            .validation_failed, status: 400, message: "Validation failed.", moneyMoved: nil,
            fields: ["payerEmail": ["Invalid email address"], "payerName": ["Too long"], "unknown": ["x"]])))
        rig.controller.pay()
        #expect(await waitUntil { if case .rejected = rig.linkScreen?.pay { true } else { false } })
        #expect(rig.linkScreen?.pay == .rejected(message: "Check the highlighted fields. No money has moved."))
        #expect(rig.controller.form.errors == [.email: "Invalid email address", .name: "Too long"])
        #expect(rig.store.snapshot.isEmpty)
        // The corrected form is a new attempt with a new key.
        rig.service.queueInitialize(.success(CK.started()))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen?.phase == .started })
        #expect(Set(rig.service.sends.map(\.key)).count == 2)
    }

    @Test("a refusal with no field errors says what the server said, and that no money moved")
    func firstSendValidationWithoutFields() async {
        let rig = await sentRig()
        rig.service.queueInitialize(.failure(CK.refusal(.validation_failed, status: 400, message: "Idempotency-Key header is required.", moneyMoved: false)))
        rig.controller.pay()
        #expect(await waitUntil { if case .rejected = rig.linkScreen?.pay { true } else { false } })
        #expect(rig.linkScreen?.pay == .rejected(message: "Idempotency-Key header is required. No money has moved."))
    }

    @Test("an involuntary session end clears nothing: not the slot, not the form")
    func involuntaryEndClearsNothing() async {
        let rig = CheckoutRig(owner: .session(userID: CK.userOne.id))
        await rig.openPayable()
        rig.fillForm()
        rig.service.queueInitialize(.failure(CK.offline))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen != nil })
        rig.controller.sessionDidChange(.ended)
        #expect(rig.store.snapshot.count == 1)
        #expect(rig.attemptScreen?.phase == .unsettled(.noConnection))

        let typing = CheckoutRig()
        await typing.openPayable()
        typing.fillForm()
        typing.controller.sessionDidChange(.ended)
        #expect(typing.controller.form.name == CK.payerName)
        #expect(typing.controller.form.email == CK.payerEmail)
    }

    @Test("a late settled refusal for a link the person has left still clears that link's slot")
    func settledRefusalForOtherLink() async {
        let rig = await sentRig()
        let gate = Gate()
        rig.service.queueInitialize(.failure(CK.linkNotPayable), gate: gate)
        rig.controller.pay()
        #expect(await waitUntil { rig.service.sends.count == 1 })
        rig.service.queueLookup(.success(CK.lookup(CK.codeB, amountKobo: nil)))
        rig.controller.open(CK.codeB)
        #expect(await waitUntil { rig.linkScreen?.link.code == CK.codeB })
        gate.open()
        await rig.settle()
        #expect(rig.store.snapshot.isEmpty)
        #expect(rig.linkScreen?.link.code == CK.codeB)
    }
}

// MARK: - Lesson 2: written before it leaves, restored at cold start

@MainActor
@Suite("Checkout: the attempt is written down before the request leaves")
struct CheckoutPersistenceTests {
    @Test("when the request leaves, the Keychain already holds the key and the exact request")
    func writtenBeforeSend() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        rig.fillForm()
        let seen = Captured<[PendingCheckout]>([])
        let store = rig.store
        rig.service.onSend = { _ in seen.value = store.snapshot }
        rig.service.queueInitialize(.success(CK.started()))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen != nil })
        #expect(seen.value.count == 1)
        #expect(seen.value.first?.key == rig.service.sends.first?.key)
        #expect(seen.value.first?.request == rig.service.sends.first?.request)
        #expect(seen.value.first?.reference == nil)
    }

    @Test("if the attempt cannot be written, NOTHING is sent, and the screen says no money was taken")
    func notRecorded() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        rig.fillForm()
        rig.store.fail(.write)
        rig.controller.pay()
        #expect(rig.linkScreen?.pay == .notRecorded)
        await rig.settle()
        #expect(rig.service.sends.isEmpty)
        #expect(rig.store.snapshot.isEmpty)
        #expect(CheckoutCopy.notRecorded.contains("No money was taken"))
        // The form is still there, and Pay works once storage does.
        rig.store.heal()
        rig.service.queueInitialize(.success(CK.started()))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen?.phase == .started })
    }

    @Test("the reference is stored with the attempt, and Back then re-tap shows the same 'Payment started'")
    func startedSurvivesBack() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        rig.fillForm()
        rig.service.queueInitialize(.success(CK.started()))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen?.phase == .started })
        #expect(rig.store.snapshot.first?.reference == CK.reference)
        let before = rig.attemptScreen
        rig.controller.close()
        #expect(rig.controller.screen == .idle)
        rig.controller.open(CK.codeA)
        #expect(rig.attemptScreen == before)
        #expect(rig.service.lookups.count == 1)
    }

    @Test("a cold start finds 'Payment started' with the same reference, before any session has resolved")
    func coldStartStarted() async {
        let rig = CheckoutRig(owner: .session(userID: nil))
        await rig.openPayable()
        rig.fillForm()
        rig.service.queueInitialize(.success(CK.started()))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen?.phase == .started })

        // A new process: nobody is signed in or resolving as far as the checkout has been told.
        let cold = rig.relaunched()
        cold.controller.open(CK.codeA)
        #expect(cold.attemptScreen?.phase == .started)
        #expect(cold.attemptScreen?.reference == CK.reference)
        #expect(cold.service.lookups.isEmpty)
    }

    @Test("if the reference cannot be written the screen still says started and the key is still stored")
    func referenceWriteFails() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        rig.fillForm()
        let store = rig.store
        rig.service.onSend = { _ in store.fail(.write) }
        rig.service.queueInitialize(.success(CK.started()))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen?.phase == .started })
        #expect(rig.store.snapshot.first?.reference == nil)
        // Reopening cannot know the reference, so it is an interrupted attempt under the SAME key, and a retry gets it back.
        rig.controller.close()
        rig.controller.open(CK.codeA)
        #expect(rig.attemptScreen?.phase == .unsettled(.interrupted))
        rig.store.heal()
        rig.service.queueInitialize(.success(CK.started()))
        rig.controller.retry()
        #expect(await waitUntil { rig.attemptScreen?.phase == .started })
        #expect(rig.keys.made == 1)
        #expect(Set(rig.service.sends.map(\.key)).count == 1)
    }

    @Test("a second link works on a warm start, and the first link's attempt is still there")
    func warmSecondLink() async {
        let rig = CheckoutRig()
        await rig.openPayable(CK.codeA)
        rig.fillForm()
        rig.service.queueInitialize(.failure(CK.offline))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen != nil })

        await rig.openPayable(CK.codeB, amountKobo: nil)
        #expect(rig.linkScreen?.link.code == CK.codeB)
        #expect(rig.controller.form.isEmpty)
        #expect(rig.store.snapshot.map(\.request.code) == [CK.codeA])

        rig.service.queueLookup(.success(CK.lookup(CK.codeA)))
        rig.controller.open(CK.codeA)
        #expect(rig.attemptScreen?.phase == .unsettled(.interrupted))
    }

    @Test("a slot that cannot be read blocks the link: nothing is sent, and it is not read as 'no attempt'")
    func unreadableStorage() async {
        let rig = CheckoutRig()
        rig.store.fail(.read)
        rig.controller.open(CK.codeA)
        #expect(rig.controller.screen == .storageBlocked(CK.codeA, .unreadable))
        #expect(rig.service.lookups.isEmpty)
        rig.store.heal()
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.reload()
        #expect(await waitUntil { rig.linkScreen != nil })
    }

    @Test("a slot this build cannot decode blocks the link until the person starts a new payment")
    func undecodableSlot() async {
        let rig = CheckoutRig()
        rig.store.plantUnreadable(CK.codeA)
        rig.controller.open(CK.codeA)
        #expect(rig.controller.screen == .storageBlocked(CK.codeA, .undecodable))
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.startOver()
        #expect(await waitUntil { rig.linkScreen != nil })
        #expect(rig.store.snapshot.isEmpty)
    }
}

// MARK: - Start a new payment

@MainActor
@Suite("Checkout: Start a new payment")
struct CheckoutStartOverTests {
    private func startedRig() async -> CheckoutRig {
        let rig = CheckoutRig()
        await rig.openPayable()
        rig.fillForm()
        rig.service.queueInitialize(.success(CK.started()))
        rig.controller.pay()
        _ = await waitUntil { rig.attemptScreen?.phase == .started }
        return rig
    }

    @Test("it forgets the attempt, reads the link again and opens an EMPTY form: the stored name and email are never shown again")
    func startOver() async {
        let rig = await startedRig()
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.startOver()
        #expect(await waitUntil { rig.linkScreen != nil })
        #expect(rig.store.snapshot.isEmpty)
        #expect(rig.controller.form.isEmpty)
        #expect(rig.controller.form.errors.isEmpty)
        // The next Pay is a new attempt.
        rig.fillForm(name: "Someone Else", email: "else@example.test")
        rig.service.queueInitialize(.success(CK.started(reference: CK.otherReference)))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen?.reference == CK.otherReference })
        #expect(Set(rig.service.sends.map(\.key)).count == 2)
    }

    @Test("if the Keychain will not let go, NOTHING changes and the screen says so")
    func startOverFails() async {
        let rig = await startedRig()
        rig.store.fail(.remove)
        let before = rig.attemptScreen
        rig.controller.startOver()
        #expect(rig.attemptScreen?.startOverFailed == true)
        var unchanged = rig.attemptScreen
        unchanged?.startOverFailed = false
        #expect(unchanged == before)
        #expect(rig.store.snapshot.count == 1)
        #expect(rig.service.lookups.count == 1)
        // And it works once the Keychain does.
        rig.store.heal()
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.startOver()
        #expect(await waitUntil { rig.linkScreen != nil })
        #expect(rig.store.snapshot.isEmpty)
    }

    @Test("it does nothing while a request is in flight")
    func startOverWhileSending() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        rig.fillForm()
        rig.service.queueInitialize(.failure(CK.offline))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen != nil })
        let gate = Gate()
        rig.service.queueInitialize(.success(CK.started()), gate: gate)
        rig.controller.retry()
        rig.controller.startOver()
        #expect(rig.store.snapshot.count == 1)
        gate.open()
        #expect(await waitUntil { rig.attemptScreen?.phase == .started })
    }

    @Test("the confirm text names the reference and tells the person to check with the merchant first")
    func confirmCopy() {
        let started = CheckoutCopy.startOverMessage(reference: CK.reference, merchant: "Adebayo Stores")
        #expect(started == "This forgets payment kbl_aBcDeFgHjK on this iPhone and starts again. If you already paid, check with Adebayo Stores first.")
        let unknown = CheckoutCopy.startOverMessage(reference: nil, merchant: "Adebayo Stores")
        #expect(unknown.contains("If you already paid, check with Adebayo Stores first."))
    }
}

// MARK: - What a stored attempt may show

@MainActor
@Suite("Checkout: a stored payer's name and email never reach a screen")
struct CheckoutPrivacyTests {
    private func assertNoPayerDetails(_ rig: CheckoutRig, _ label: String) {
        let shown = String(describing: rig.controller.screen) + rig.controller.form.name + rig.controller.form.email
        #expect(!shown.contains("Ngozi"), "\(label) shows the payer's name")
        #expect(!shown.contains("Okafor"), "\(label) shows the payer's name")
        #expect(!shown.contains("ngozi@example.test"), "\(label) shows the payer's email")
    }

    @Test("started, unsettled, interrupted, sending and blocked screens carry no name or email; the form is empty after every way back")
    func noDetailsInAnyState() async {
        let rig = CheckoutRig()
        await rig.openPayable()
        rig.fillForm()
        let gate = Gate()
        rig.service.queueInitialize(.failure(CK.offline), gate: gate)
        rig.controller.pay()
        #expect(await waitUntil { rig.service.sends.count == 1 })
        rig.controller.close()
        rig.controller.open(CK.codeA)
        #expect(rig.attemptScreen?.phase == .sending)
        assertNoPayerDetails(rig, "sending")
        gate.open()
        #expect(await waitUntil { rig.attemptScreen?.phase == .unsettled(.interrupted) || rig.attemptScreen?.phase == .unsettled(.noConnection) })
        assertNoPayerDetails(rig, "unsettled")
        rig.controller.close()
        rig.controller.open(CK.codeA)
        assertNoPayerDetails(rig, "interrupted")
        rig.service.queueInitialize(.success(CK.started()))
        rig.controller.retry()
        #expect(await waitUntil { rig.attemptScreen?.phase == .started })
        assertNoPayerDetails(rig, "started")
        // A relaunch, and every way to a new form.
        let cold = rig.relaunched()
        cold.controller.open(CK.codeA)
        assertNoPayerDetails(cold, "cold start")
        cold.service.queueLookup(.success(CK.lookup()))
        cold.controller.startOver()
        #expect(await waitUntil { cold.linkScreen != nil })
        assertNoPayerDetails(cold, "start over")
        #expect(cold.controller.form.isEmpty)
        let blocked = CheckoutRig()
        blocked.store.fail(.read)
        blocked.controller.open(CK.codeA)
        assertNoPayerDetails(blocked, "blocked")
    }

    @Test("the types a screen is made of have no place for a name or an email")
    func screenTypesHaveNoPayerFields() {
        let mirror = Mirror(reflecting: AttemptScreen(code: CK.codeA, merchantName: "m", title: "t", amountKobo: 1, reference: nil, phase: .started))
        let names = Set(mirror.children.compactMap(\.label))
        #expect(names == ["code", "merchantName", "title", "amountKobo", "reference", "phase", "startOverFailed"])
    }
}

@MainActor
@Suite("Checkout: storage that cannot be cleared")
struct CheckoutBlockedStorageTests {
    @Test("Start a new payment on an unreadable record that cannot be removed says so, and changes nothing")
    func undecodableClearFails() async {
        let rig = CheckoutRig()
        rig.store.plantUnreadable(CK.codeA)
        rig.controller.open(CK.codeA)
        #expect(rig.controller.screen == .storageBlocked(CK.codeA, .undecodable))
        rig.store.fail(.remove)
        rig.controller.startOver()
        #expect(rig.controller.screen == .storageBlocked(CK.codeA, .undecodableClearFailed))
        #expect(rig.service.lookups.isEmpty)
        // It still works once storage does.
        rig.store.heal()
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.startOver()
        #expect(await waitUntil { rig.linkScreen != nil })
    }

    @Test("a record that may already have been sent is never described as nothing having been sent")
    func blockedCopy() {
        for block in [StorageBlock.unreadable, .undecodable, .undecodableClearFailed, .cannotClear, .obligationUnreadable, .resetFailed] {
            let notice = CheckoutCopy.storageBlocked(block)
            let words = [notice.heading, notice.body ?? "", notice.moneyLine, notice.nextStep].joined(separator: " ")
            #expect(!words.contains("Nothing was sent"), "\(block)")
            #expect(!words.lowercased().contains("no money"), "\(block)")
            #expect(notice.moneyLine == "A payment may already have been started on this link.", "\(block)")
            #expect(words.lowercased().contains("check with the merchant before paying again"), "\(block)")
        }
    }

    @Test("a late 'could not confirm' answer never downgrades a started payment")
    func noDowngrade() async throws {
        let rig = CheckoutRig()
        await rig.openPayable()
        rig.fillForm()
        rig.service.queueInitialize(.success(CK.started()))
        rig.controller.pay()
        #expect(await waitUntil { rig.attemptScreen?.phase == .started })
        let stored = try #require(rig.store.snapshot.first)
        rig.controller.applyOutcome(.failure(CK.offline), context: .init(pending: stored, firstEverSend: false))
        #expect(rig.attemptScreen?.phase == .started)
        #expect(rig.attemptScreen?.reference == CK.reference)
    }

    @Test("a payer's request still in the air when someone signs in stays 'sending': no second send, and its answer lands")
    func inFlightPayerAttemptSurvivesSignIn() async {
        let rig = CheckoutRig(owner: .payer)
        await rig.openPayable()
        rig.fillForm()
        let gate = Gate()
        rig.service.queueInitialize(.success(CK.started()), gate: gate)
        rig.controller.pay()
        #expect(await waitUntil { rig.service.sends.count == 1 })
        rig.service.queueLookup(.success(CK.lookup()))
        rig.controller.sessionDidChange(.signedIn(CK.userOne))
        #expect(rig.attemptScreen?.phase == .sending)
        rig.controller.retry()
        #expect(rig.service.sends.count == 1)
        gate.open()
        #expect(await waitUntil { rig.attemptScreen?.phase == .started })
        #expect(rig.service.sends.count == 1)
    }
}
