import Foundation
import Testing

@testable import KobolinkKit

// The send state machine. Its lessons come from Android's M5, which was blocked three times on one theme: after a
// payment's outcome is unknown, a refusal that only applies to the replay (a 401, a validation 400) or a local
// storage failure was read as proof the original never posted, the pending record was cleared, the screen said
// "No money was taken", and a fresh key was offered (a double payment).

@MainActor
@Suite("Send: the happy path and one request per tap")
struct SendHappyPathTests {
    @Test("form, review, send: a posted transfer shows as sent, updates the home and clears the stored attempt")
    func happy() async {
        let rig = WalletRig()
        let receipt = WK.receipt(for: WK.instruction(note: "Rent"), balanceKobo: 3_000_000)
        rig.service.queueTransfer(.success(receipt))

        rig.startPayment(note: "Rent")
        #expect(await waitUntil { rig.isSent })

        guard case .sent(let attempt, let shown, let replayed) = rig.send.screen else { Issue.record("not sent"); return }
        #expect(shown == receipt)
        #expect(!replayed)
        #expect(attempt.instruction == WK.instruction(note: "Rent"))
        #expect(rig.store.snapshot.isEmpty)
        #expect(rig.send.unresolved == nil)
        #expect(rig.home.balance?.balanceKobo == 3_000_000)
        #expect(rig.home.items.first == receipt.activity)
    }

    @Test("the form is normalised: the number goes out as E.164 and a blank note is not sent at all")
    func normalised() async {
        let rig = WalletRig()
        rig.service.queueTransfer(.success(WK.receipt()))
        rig.startPayment(phone: "  0803-123-4567 ", amount: "1,500", note: "   ")
        #expect(await waitUntil { rig.service.sends.count == 1 })
        #expect(rig.service.sends[0].instruction == TransferInstruction(toPhone: "+2348031234567", amountKobo: 150_000, note: nil))
    }

    @Test("a double tap on Send is one request")
    func doubleTap() async {
        let rig = WalletRig()
        let gate = Gate()
        rig.service.queueTransfer(.success(WK.receipt()), gate: gate)
        rig.startPayment()
        rig.send.confirm()
        rig.send.confirm()
        #expect(await waitUntil { rig.service.sends.count == 1 })
        gate.open()
        #expect(await waitUntil { rig.isSent })
        rig.send.confirm()
        #expect(rig.service.sends.count == 1)
        #expect(rig.keys.made == 1)
    }

    @Test("an invalid form is not reviewed and nothing is stored")
    func invalidForm() {
        let rig = WalletRig()
        rig.wallet.openSend()
        rig.fillForm(phone: "12345", amount: "50", note: "")
        rig.send.review()
        #expect(rig.send.screen == .form)
        #expect(rig.send.form.errors[.phone] == SendValidation.phoneInvalid)
        #expect(rig.send.form.errors[.amount] == SendValidation.amountTooSmall)
        rig.send.confirm()
        #expect(rig.service.sends.isEmpty)
        #expect(rig.store.everSaved.isEmpty)
    }

    @Test("two payments get two keys; a key is never reused for a second payment")
    func twoPayments() async {
        let rig = WalletRig()
        rig.service.queueTransfer(.success(WK.receipt(id: "pst_1")))
        rig.startPayment()
        #expect(await waitUntil { rig.isSent })
        rig.wallet.sheetDidDismiss()
        rig.service.queueTransfer(.success(WK.receipt(id: "pst_2")))
        rig.startPayment(phone: "09012345678")
        #expect(await waitUntil { rig.service.sends.count == 2 })
        #expect(rig.service.sends[0].key != rig.service.sends[1].key)
    }
}

@MainActor
@Suite("Send: written down before it leaves")
struct SendWriteBeforeSendTests {
    @Test("the attempt, with its key and exact request, is in storage when the request leaves")
    func storedBeforeSend() async {
        let rig = WalletRig()
        let seen = LockedBox<[TransferAttempt]>([])
        let store = rig.store
        rig.service.onSend = { _ in seen.set(store.snapshot) }
        rig.service.queueTransfer(.success(WK.receipt()))
        rig.startPayment(note: "Lunch")
        #expect(await waitUntil { rig.isSent })
        let held = seen.value
        #expect(held.count == 1)
        #expect(held.first?.key == rig.service.sends[0].key)
        #expect(held.first?.userID == WK.userOne.id)
        #expect(held.first?.instruction == rig.service.sends[0].instruction)
        #expect(held.first?.instruction.note == "Lunch")
    }

    @Test("if the attempt cannot be written, NOTHING is sent and the screen says no money was taken")
    func writeFails() async {
        let rig = WalletRig()
        rig.store.fail(.write)
        rig.startPayment()
        #expect(rig.service.sends.isEmpty)
        guard case .failed(_, let failure) = rig.send.screen else { Issue.record("not failed"); return }
        #expect(failure == .notRecorded)
        #expect(failure.money == .notMoved)
        #expect(rig.send.unresolved == nil)
        await rig.settle()
        #expect(rig.service.sends.isEmpty)

        // Try Again goes back to the review step; once storage works, Send makes a fresh attempt.
        rig.send.tryAgain()
        guard case .confirm = rig.send.screen else { Issue.record("not back at review"); return }
        rig.store.heal()
        rig.service.queueTransfer(.success(WK.receipt()))
        rig.send.confirm()
        #expect(await waitUntil { rig.isSent })
        #expect(rig.service.sends.count == 1)
    }

    @Test("a storage failure on a RETRY changes nothing: the retry writes nothing, and resends the same key")
    func retryWritesNothing() async {
        let rig = WalletRig()
        rig.service.queueTransfer(.failure(WK.offline))
        rig.startPayment()
        #expect(await waitUntil { rig.failure != nil })
        let savedBefore = rig.store.everSaved.count
        rig.store.fail(.write)
        rig.store.fail(.read)
        rig.service.queueTransfer(.success(WK.receipt()))
        rig.send.tryAgain()
        #expect(await waitUntil { rig.isSent })
        #expect(rig.store.everSaved.count == savedBefore)
        #expect(rig.service.sends.count == 2)
        #expect(rig.service.sends[0] == rig.service.sends[1])
    }
}

@MainActor
@Suite("Send: an unknown outcome keeps its key")
struct SendUnknownOutcomeTests {
    /// Every answer that does not prove the original never posted, as the FIRST reply to a send.
    nonisolated static let unknowns: [(String, APIError)] = [
        ("offline", WK.offline),
        ("timeout", .unreachable(.timedOut)),
        ("connection lost", .unreachable(.networkConnectionLost)),
        ("cancelled", .cancelled),
        ("500", WK.refusal(._internal, status: 500, message: "Something went wrong.", moneyMoved: nil)),
        ("502 page", .unexpectedResponse(status: 502)),
        ("503 body", WK.refusal(.conflict, status: 503, message: "Busy.", moneyMoved: nil)),
        ("unparseable reply", .undecodableResponse),
        ("redirect", .unexpectedResponse(status: 302)),
        ("401", WK.unauthenticated),
        ("401 page", .unexpectedResponse(status: 401)),
        ("429", WK.refusal(.rate_limited, status: 429, message: "Slow down.", moneyMoved: nil, retryAfter: 30)),
        ("idempotency mismatch", WK.mismatch),
        ("403", WK.refusal(.forbidden, status: 403, message: "No.", moneyMoved: nil)),
        ("409", WK.refusal(.conflict, status: 409, message: "Conflict.", moneyMoved: nil)),
        ("a refusal with moneyMoved false that the layer does not store", WK.refusal(.forbidden, status: 403, message: "No.")),
    ]

    @Test("after any of these, the attempt and its key are kept, the screen is failed with money UNKNOWN, and Try Again resends the identical request under the same key", arguments: unknowns)
    func keptAfterFirstSend(_ name: String, _ error: APIError) async {
        let rig = WalletRig()
        rig.service.queueTransfer(.failure(error))
        rig.startPayment(note: "Rent")
        #expect(await waitUntil { rig.failure != nil }, "\(name)")
        let failure = rig.failure
        #expect(failure?.money == .unknown, "\(name)")
        #expect(rig.store.snapshot.count == 1, "\(name)")
        #expect(rig.send.unresolved != nil, "\(name)")

        rig.service.queueTransfer(.success(WK.receipt(for: WK.instruction(note: "Rent"))))
        rig.send.tryAgain()
        #expect(await waitUntil { rig.isSent }, "\(name)")
        #expect(rig.service.sends.count == 2)
        #expect(rig.service.sends[0] == rig.service.sends[1], "\(name): same key, same request")
        #expect(rig.keys.made == 1, "\(name): no second key was ever made")
        #expect(rig.store.snapshot.isEmpty)
    }

    @Test("a refusal that only applies to the REPLAY does not settle the attempt: it stays, with the same key", arguments: unknowns + [
        ("validation on a replay", WK.badBody),
        ("validation with moneyMoved false on a replay", WK.refusal(.validation_failed, status: 400, message: "Validation failed.", fields: ["amountKobo": ["x"]])),
    ])
    func keptAfterReplay(_ name: String, _ error: APIError) async {
        let rig = WalletRig()
        rig.service.queueTransfer(.failure(WK.offline))
        rig.startPayment()
        #expect(await waitUntil { rig.failure != nil })
        rig.service.queueTransfer(.failure(error))
        rig.send.tryAgain()
        #expect(await waitUntil { rig.service.sends.count == 2 && rig.failure != nil && rig.send.screen.unresolvedAttempt != nil })
        await rig.settle()
        #expect(rig.failure?.money == .unknown, "\(name)")
        #expect(rig.store.snapshot.count == 1, "\(name): the record is still there")
        #expect(rig.send.unresolved != nil, "\(name)")
        #expect(rig.keys.made == 1, "\(name)")
        // And the way forward is still the same request.
        rig.service.queueTransfer(.failure(WK.offline))
        rig.send.tryAgain()
        #expect(await waitUntil { rig.service.sends.count == 3 })
        #expect(Set(rig.service.sends.map(\.key)).count == 1)
    }

    @Test("an unknown outcome cannot be edited: the form is not reachable and review does nothing")
    func noEditing() async {
        let rig = WalletRig()
        rig.service.queueTransfer(.failure(WK.offline))
        rig.startPayment()
        #expect(await waitUntil { rig.failure != nil })
        rig.send.editDetails()
        guard case .failed = rig.send.screen else { Issue.record("left the failure"); return }
        rig.send.review()
        rig.send.confirm()
        rig.send.startScanning()
        #expect(rig.service.sends.count == 1)
        // Reopening Send shows the unfinished payment, not a fresh form.
        rig.wallet.sheetDidDismiss()
        rig.wallet.openSend()
        guard case .failed(let shown, _) = rig.send.screen else { Issue.record("fresh form offered"); return }
        #expect(shown.key == rig.service.sends[0].key)
        rig.wallet.openScan()
        guard case .failed = rig.send.screen else { Issue.record("camera offered"); return }
    }

    @Test("a reply that is about some other payment is not an answer to this one")
    func wrongReceipt() async {
        let rig = WalletRig()
        rig.service.queueTransfer(.success(WK.receipt(for: WK.instruction(amountKobo: 999_000))))
        rig.startPayment()
        #expect(await waitUntil { rig.failure != nil })
        #expect(rig.failure == .unreadable)
        #expect(rig.store.snapshot.count == 1)
    }

    @Test("a late 'could not confirm' never takes back a success that already arrived")
    func lateUnsettled() async {
        let rig = WalletRig()
        rig.startPayment()
        // `sending` is on screen; a success lands, then a stale unsettled result for the same attempt arrives.
        guard let attempt = rig.attemptOnScreen else { Issue.record("not sending"); return }
        rig.send.apply(.success(WK.receipt()), attempt: attempt, firstEverSend: true)
        rig.send.apply(.failure(WK.offline), attempt: attempt, firstEverSend: false)
        #expect(rig.isSent)
    }
}

@MainActor
@Suite("Send: refusals the server stores are the answer")
struct SendSettledTests {
    nonisolated static let settled: [(String, APIError, TransferFailure)] = [
        ("insufficient funds", WK.insufficient, .insufficientFunds),
        ("no wallet for the number", WK.noWallet, .recipientNotFound),
        ("own number", WK.ownNumber, .ownNumber),
    ]

    @Test("on a first send these end the attempt: nothing is kept, the form comes back, a new payment gets a new key", arguments: settled)
    func settledFirstSend(_ name: String, _ error: APIError, _ expected: TransferFailure) async {
        let rig = WalletRig()
        rig.service.queueTransfer(.failure(error))
        rig.startPayment()
        #expect(await waitUntil { rig.failure != nil }, "\(name)")
        #expect(rig.failure == expected)
        #expect(rig.failure?.money == .notMoved)
        #expect(rig.store.snapshot.isEmpty)
        #expect(rig.send.unresolved == nil)

        rig.send.editDetails()
        #expect(rig.send.screen == .form)
        #expect(rig.send.form.phone == "0803 123 4567")
        rig.send.form.amountText = "1200"
        rig.send.review()
        rig.service.queueTransfer(.success(WK.receipt(for: WK.instruction(amountKobo: 120_000))))
        rig.send.confirm()
        #expect(await waitUntil { rig.isSent })
        #expect(rig.service.sends[0].key != rig.service.sends[1].key)
        #expect(rig.keys.made == 2)
    }

    @Test("the same refusals end it on a REPLAY too: they are the stored answer for the key", arguments: settled)
    func settledOnReplay(_ name: String, _ error: APIError, _ expected: TransferFailure) async {
        let rig = WalletRig()
        rig.service.queueTransfer(.failure(WK.offline))
        rig.startPayment()
        #expect(await waitUntil { rig.failure != nil })
        rig.service.queueTransfer(.failure(error))
        rig.send.tryAgain()
        #expect(await waitUntil { rig.failure == expected }, "\(name)")
        #expect(rig.store.snapshot.isEmpty)
        #expect(rig.send.unresolved == nil)
    }

    @Test("insufficient funds refreshes the balance: the one on screen was wrong")
    func insufficientRefreshes() async {
        let rig = WalletRig()
        // Opening Send reads the home once; let that finish so the refresh under test is the next one.
        rig.wallet.openSend()
        #expect(await waitUntil { rig.home.hasLoaded })
        #expect(rig.home.balance == nil)
        rig.service.queueTransfer(.failure(WK.insufficient))
        rig.service.queueWallet(.success(WK.balance(20_000)))
        rig.service.queueActivity(.success(ActivityPage(items: [], nextCursor: nil)))
        rig.fillForm()
        rig.send.review()
        rig.send.confirm()
        #expect(await waitUntil { rig.home.balance?.balanceKobo == 20_000 })
    }

    @Test("a validation refusal on the very first send ends it, with its fields shown beside the form")
    func firstSendValidation() async {
        let rig = WalletRig()
        rig.service.queueTransfer(.failure(WK.badBody))
        rig.startPayment()
        #expect(await waitUntil { rig.failure != nil })
        guard case .invalidDetails(_, let fields)? = rig.failure else { Issue.record("\(String(describing: rig.failure))"); return }
        #expect(fields[.amount] == "Too small")
        #expect(rig.failure?.money == .notMoved)
        #expect(rig.store.snapshot.isEmpty)
        rig.send.editDetails()
        #expect(rig.send.form.errors[.amount] == "Too small")
    }

    @Test("a refusal with a lookalike code but no moneyMoved:false proof settles nothing")
    func lookalike() async {
        let rig = WalletRig()
        rig.service.queueTransfer(.failure(WK.refusal(.insufficient_funds, status: 422, moneyMoved: nil)))
        rig.startPayment()
        #expect(await waitUntil { rig.failure != nil })
        #expect(rig.failure?.money == .unknown)
        #expect(rig.store.snapshot.count == 1)

        let other = WalletRig()
        other.service.queueTransfer(.failure(WK.refusal(.insufficient_funds, status: 400, moneyMoved: false)))
        other.startPayment()
        #expect(await waitUntil { other.failure != nil })
        #expect(other.failure?.money == .unknown, "a status the layer never stores for it")
    }
}

@MainActor
@Suite("Send: discarding an unresolved payment")
struct SendDiscardTests {
    private func unresolved() async -> WalletRig {
        let rig = WalletRig()
        rig.service.queueTransfer(.failure(WK.offline))
        rig.startPayment()
        _ = await waitUntil { rig.failure != nil }
        return rig
    }

    @Test("'I checked: it didn't go through' removes the record and opens an empty form")
    func discard() async {
        let rig = await unresolved()
        rig.send.discardUnresolved()
        #expect(rig.store.snapshot.isEmpty)
        #expect(rig.send.unresolved == nil)
        #expect(rig.send.screen == .form)
        #expect(rig.send.form.isEmpty)
        // And a payment now is a new attempt with a new key.
        rig.fillForm()
        rig.send.review()
        rig.service.queueTransfer(.success(WK.receipt()))
        rig.send.confirm()
        #expect(await waitUntil { rig.isSent })
        #expect(rig.keys.made == 2)
    }

    @Test("if storage will not let go, NOTHING changes and the screen says so")
    func discardFails() async {
        let rig = await unresolved()
        rig.store.fail(.remove)
        rig.send.discardUnresolved()
        #expect(rig.send.discardFailed)
        #expect(rig.store.snapshot.count == 1)
        #expect(rig.send.unresolved != nil)
        guard case .failed(_, let failure) = rig.send.screen else { Issue.record("left the failure"); return }
        #expect(failure.money == .unknown)
        rig.store.heal()
        rig.send.discardUnresolved()
        #expect(!rig.send.discardFailed)
        #expect(rig.store.snapshot.isEmpty)
    }

    @Test("it only works on an unresolved payment")
    func onlyUnresolved() async {
        let rig = WalletRig()
        rig.wallet.openSend()
        rig.send.discardUnresolved()
        #expect(rig.send.screen == .form)
        rig.service.queueTransfer(.failure(WK.insufficient))
        rig.fillForm()
        rig.send.review()
        rig.send.confirm()
        #expect(await waitUntil { rig.failure != nil })
        rig.send.discardUnresolved()
        guard case .failed = rig.send.screen else { Issue.record("left"); return }
    }
}

@MainActor
@Suite("Send: leaving the screen, relaunch")
struct SendLeavingTests {
    @Test("closing the sheet on the form empties it; on an unknown outcome it keeps the payment")
    func closing() async {
        let rig = WalletRig()
        rig.wallet.openSend()
        rig.fillForm(note: "hello")
        rig.wallet.sheetDidDismiss()
        #expect(rig.send.screen == .idle)
        #expect(rig.send.form.isEmpty)

        rig.service.queueTransfer(.failure(WK.offline))
        rig.startPayment()
        #expect(await waitUntil { rig.failure != nil })
        rig.wallet.sheetDidDismiss()
        #expect(rig.send.unresolved != nil)
        guard case .failed = rig.send.screen else { Issue.record("dropped"); return }
    }

    @Test("leaving while the request is in the air does not lose its answer")
    func leavingWhileSending() async {
        let rig = WalletRig()
        let gate = Gate()
        rig.service.queueTransfer(.success(WK.receipt()), gate: gate)
        rig.startPayment()
        #expect(await waitUntil { rig.service.sends.count == 1 })
        rig.wallet.sheetDidDismiss()
        guard case .sending = rig.send.screen else { Issue.record("dropped while sending"); return }
        // Opening Send again shows the payment in flight, and Send cannot be tapped into a second one.
        rig.wallet.openSend()
        guard case .sending = rig.send.screen else { Issue.record("fresh form while sending"); return }
        rig.send.confirm()
        rig.send.tryAgain()
        gate.open()
        #expect(await waitUntil { rig.isSent })
        #expect(rig.service.sends.count == 1)
        #expect(rig.store.snapshot.isEmpty)
    }

    @Test("a relaunch restores the attempt as 'we never saw how it ended'; Try Again resends the same request under the same key")
    func relaunch() async {
        let first = WalletRig()
        first.service.queueTransfer(.failure(WK.offline))
        first.startPayment(note: "Rent")
        #expect(await waitUntil { first.failure != nil })
        let key = first.service.sends[0].key

        let second = first.relaunched()
        guard case .failed(let attempt, let failure) = second.send.screen else { Issue.record("\(second.send.screen)"); return }
        #expect(attempt.key == key)
        #expect(failure == .interrupted)
        #expect(failure.money == .unknown)
        #expect(second.send.unresolved != nil)

        second.service.queueTransfer(.success(WK.receipt(for: WK.instruction(note: "Rent"))))
        second.send.tryAgain()
        #expect(await waitUntil { second.isSent })
        #expect(second.service.sends[0] == first.service.sends[0])
        #expect(second.keys.made == 0)
        guard case .sent(_, _, let replayed) = second.send.screen else { return }
        #expect(replayed, "a retry's answer is the stored original")
        #expect(second.store.snapshot.isEmpty)
    }

    @Test("a retry is called a replay only when the posting is demonstrably older than the retry that returned it")
    func replayNeedsEvidence() async {
        let retryAt = WK.at.addingTimeInterval(3600)
        // (posted, is it demonstrably the stored original of an earlier send?)
        let cases: [(Date, Bool)] = [
            (retryAt.addingTimeInterval(-600), true),  // ten minutes before this retry left
            (retryAt.addingTimeInterval(-2), false),  // inside the clock-skew margin
            (retryAt, false),  // the retry itself posted it
            (retryAt.addingTimeInterval(3), false),  // later than the retry left
        ]
        for (posted, expected) in cases {
            let rig = WalletRig(now: { retryAt })
            rig.service.queueTransfer(.failure(WK.offline))
            rig.startPayment()
            #expect(await waitUntil { rig.failure != nil })
            rig.service.queueTransfer(.success(WK.receipt(asOf: posted)))
            rig.send.tryAgain()
            #expect(await waitUntil { rig.isSent })
            guard case .sent(_, _, let replayed) = rig.send.screen else { Issue.record("not sent"); return }
            #expect(replayed == expected, "posted \(posted.timeIntervalSince(retryAt))s from the retry")
        }
    }

    @Test("the first send is never called a replay, whatever the clocks say")
    func firstSendNeverReplay() async {
        let rig = WalletRig(now: { WK.at.addingTimeInterval(3600) })
        rig.service.queueTransfer(.success(WK.receipt(asOf: WK.at)))
        rig.startPayment()
        #expect(await waitUntil { rig.isSent })
        guard case .sent(_, _, let replayed) = rig.send.screen else { Issue.record("not sent"); return }
        #expect(!replayed)
    }

    @Test("a process killed while the request was in the air looks the same on the next launch")
    func killedMidFlight() async {
        let first = WalletRig()
        let gate = Gate()
        first.service.queueTransfer(.success(WK.receipt()), gate: gate)
        first.startPayment()
        #expect(await waitUntil { first.service.sends.count == 1 })
        let second = first.relaunched()
        guard case .failed(let attempt, .interrupted) = second.send.screen else { Issue.record("\(second.send.screen)"); return }
        #expect(attempt.key == first.service.sends[0].key)
        gate.open()
    }

    @Test("a payment sent but not removed from storage does not look like a failure on screen, and a restart offers a Try Again that returns the success")
    func removalFails() async {
        let rig = WalletRig()
        rig.service.queueTransfer(.success(WK.receipt()))
        rig.store.fail(.remove)
        rig.startPayment()
        #expect(await waitUntil { rig.isSent })
        #expect(rig.store.snapshot.count == 1)
        #expect(rig.send.unresolved == nil)
        rig.store.heal()
        let again = rig.relaunched()
        guard case .failed(_, .interrupted) = again.send.screen else { Issue.record("\(again.send.screen)"); return }
        again.service.queueTransfer(.success(WK.receipt()))
        again.send.tryAgain()
        #expect(await waitUntil { again.isSent })
        #expect(again.store.snapshot.isEmpty)
    }
}

@MainActor
@Suite("Send: a QR payee's name")
struct SendScannedNameTests {
    let payee = ScannedPayee(toPhone: WK.phoneA, displayName: "Ada Obi", amountKobo: 250_000)

    @Test("a scanned code fills the form: the number, the amount, and the name kept beside it as unverified")
    func fills() {
        let rig = WalletRig()
        rig.wallet.openScan()
        #expect(rig.send.screen == .scan)
        rig.wallet.scan.onPayee?(payee)
        #expect(rig.send.screen == .form)
        #expect(rig.send.form.phone == WK.displayA)
        #expect(rig.send.form.amountText == "2500")
        #expect(rig.send.form.scannedName == "Ada Obi")
    }

    @Test("editing the number drops the name; retyping the same number does not")
    func editingDropsName() {
        let rig = WalletRig()
        rig.wallet.openScan()
        rig.wallet.scan.onPayee?(payee)
        rig.send.form.setPhone("0803 123 456")
        #expect(rig.send.form.scannedName == nil)

        rig.wallet.sheetDidDismiss()
        rig.wallet.openScan()
        rig.wallet.scan.onPayee?(payee)
        rig.send.form.setPhone("08031234567")
        #expect(rig.send.form.scannedName == "Ada Obi", "the same number written another way is still that number")
        rig.send.form.setPhone("08031234568")
        #expect(rig.send.form.scannedName == nil)
        rig.send.form.setPhone("08031234567")
        #expect(rig.send.form.scannedName == nil, "once dropped it does not come back")
    }

    @Test("the name travels with the draft and the attempt, and a dropped name does not")
    func travels() async {
        let rig = WalletRig()
        rig.wallet.openScan()
        rig.wallet.scan.onPayee?(payee)
        rig.send.review()
        guard case .confirm(let draft) = rig.send.screen else { Issue.record("no review"); return }
        #expect(draft.payeeName == "Ada Obi")
        rig.service.queueTransfer(.failure(WK.offline))
        rig.send.confirm()
        #expect(await waitUntil { rig.failure != nil })
        #expect(rig.attemptOnScreen?.payeeName == "Ada Obi")
        #expect(rig.store.snapshot.first?.payeeName == "Ada Obi")

        let edited = WalletRig()
        edited.wallet.openScan()
        edited.wallet.scan.onPayee?(payee)
        edited.send.form.setPhone("09012345678")
        edited.send.review()
        guard case .confirm(let other) = edited.send.screen else { Issue.record("no review"); return }
        #expect(other.payeeName == nil)
        #expect(other.instruction.toPhone == WK.phoneB)
    }

    @Test("a scan while an earlier payment is unresolved does not replace it")
    func unresolvedWins() async {
        let rig = WalletRig()
        rig.service.queueTransfer(.failure(WK.offline))
        rig.startPayment()
        #expect(await waitUntil { rig.failure != nil })
        rig.send.useScanned(payee)
        guard case .failed = rig.send.screen else { Issue.record("replaced"); return }
        #expect(rig.send.form.scannedName == nil)
    }

    @Test("'Enter details instead' goes from the camera to the form")
    func enterDetails() {
        let rig = WalletRig()
        rig.wallet.openScan()
        rig.send.enterDetails()
        #expect(rig.send.screen == .form)
        rig.wallet.startScanning()
        #expect(rig.send.screen == .scan)
    }
}

/// A value two threads can reach, for asserting what a request saw when it "left".
final class LockedBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
    func set(_ value: Value) {
        lock.lock()
        stored = value
        lock.unlock()
    }
}
