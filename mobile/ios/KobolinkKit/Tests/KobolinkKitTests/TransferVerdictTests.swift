import Foundation
import Testing

@testable import KobolinkKit

/// The failure classification, one row per way an answer can come back, for a FIRST send and for a REPLAY. The
/// column that matters is `money`: the app says "No money was taken" only where this table says `.notMoved`.
@Suite("Transfer verdict: what an answer settles")
struct TransferVerdictTests {
    private func verdict(_ error: APIError, firstEverSend: Bool) -> TransferVerdict {
        TransferVerdict.of(.failure(error), instruction: WK.instruction(), firstEverSend: firstEverSend)
    }

    /// (name, error, first send, replay)
    static let table: [(String, APIError, TransferVerdict, TransferVerdict)] = [
        // The three the idempotency layer stores: the answer for the key, first send or replay.
        ("insufficient_funds", WK.insufficient, .settled(.insufficientFunds), .settled(.insufficientFunds)),
        ("not_found", WK.noWallet, .settled(.recipientNotFound), .settled(.recipientNotFound)),
        ("own number", WK.ownNumber, .settled(.ownNumber), .settled(.ownNumber)),

        // Body validation runs before the layer: it settles only a first send.
        (
            "body validation", WK.badBody,
            .settled(.invalidDetails(message: "Validation failed.", fields: [.amount: "Too small"])),
            .unsettled(.refused(message: "Validation failed."))
        ),
        (
            "validation with moneyMoved false but not the own-number signature",
            WK.refusal(.validation_failed, status: 400, message: "Idempotency-Key header is required."),
            .settled(.invalidDetails(message: "Idempotency-Key header is required.", fields: [:])),
            .unsettled(.refused(message: "Idempotency-Key header is required."))
        ),

        // Everything else is unknown, both times.
        ("401", WK.unauthenticated, .unsettled(.sessionEnded), .unsettled(.sessionEnded)),
        ("401 page", .unexpectedResponse(status: 401), .unsettled(.sessionEnded), .unsettled(.sessionEnded)),
        (
            "429", WK.refusal(.rate_limited, status: 429, message: "Slow down.", moneyMoved: nil, retryAfter: 30),
            .unsettled(.rateLimited(retryAfterSeconds: 30)), .unsettled(.rateLimited(retryAfterSeconds: 30))
        ),
        ("429 page", .unexpectedResponse(status: 429), .unsettled(.rateLimited(retryAfterSeconds: nil)), .unsettled(.rateLimited(retryAfterSeconds: nil))),
        ("idempotency_mismatch", WK.mismatch, .unsettled(.keyConflict), .unsettled(.keyConflict)),
        (
            "internal", WK.refusal(._internal, status: 500, message: "Boom.", moneyMoved: nil),
            .unsettled(.serverProblem), .unsettled(.serverProblem)
        ),
        ("502 page", .unexpectedResponse(status: 502), .unsettled(.serverProblem), .unsettled(.serverProblem)),
        (
            "a 5xx with a parsed body", WK.refusal(.conflict, status: 503, message: "Busy.", moneyMoved: nil),
            .unsettled(.serverProblem), .unsettled(.serverProblem)
        ),
        ("a redirect", .unexpectedResponse(status: 302), .unsettled(.unreadable), .unsettled(.unreadable)),
        ("a 404 page", .unexpectedResponse(status: 404), .unsettled(.unreadable), .unsettled(.unreadable)),
        ("an unreadable reply", .undecodableResponse, .unsettled(.unreadable), .unsettled(.unreadable)),
        ("offline", WK.offline, .unsettled(.noConnection), .unsettled(.noConnection)),
        ("a timeout", .unreachable(.timedOut), .unsettled(.noConnection), .unsettled(.noConnection)),
        ("cancelled", .cancelled, .unsettled(.noConnection), .unsettled(.noConnection)),
        (
            "forbidden", WK.refusal(.forbidden, status: 403, message: "No.", moneyMoved: nil),
            .unsettled(.refused(message: "No.")), .unsettled(.refused(message: "No."))
        ),
        (
            "a not_found without moneyMoved:false", WK.refusal(.not_found, status: 404, message: "Nope.", moneyMoved: nil),
            .unsettled(.refused(message: "Nope.")), .unsettled(.refused(message: "Nope."))
        ),
        (
            "insufficient_funds with another status", WK.refusal(.insufficient_funds, status: 400),
            .unsettled(.refused(message: "Refused.")), .unsettled(.refused(message: "Refused."))
        ),
    ]

    @Test("every answer, first send and replay", arguments: table)
    func classifies(_ name: String, _ error: APIError, _ first: TransferVerdict, _ replay: TransferVerdict) {
        #expect(verdict(error, firstEverSend: true) == first, "\(name): first send")
        #expect(verdict(error, firstEverSend: false) == replay, "\(name): replay")
    }

    @Test("the own-number refusal is recognised by the exact sentence the server writes")
    func ownNumberSentence() {
        #expect(TransferVerdict.ownNumberFieldMessage == "cannot transfer to yourself")
        let reworded = WK.refusal(.validation_failed, status: 400, fields: ["toPhone": ["you cannot pay yourself"]])
        #expect(verdict(reworded, firstEverSend: false) == .unsettled(.refused(message: "Refused.")), "a reworded server fails safe")
    }

    @Test("a 2xx that is not a posted transfer for THIS request is unreadable, never a success")
    func wrongReceipt() {
        let instruction = WK.instruction()
        let ok = WK.receipt(for: instruction)
        #expect(TransferVerdict.of(.success(ok), instruction: instruction, firstEverSend: true) == .sent(ok))
        let otherAmount = WK.receipt(for: WK.instruction(amountKobo: 160_000))
        #expect(TransferVerdict.of(.success(otherAmount), instruction: instruction, firstEverSend: false) == .unsettled(.unreadable))
        let topup = TransferReceipt(activity: WK.activity(amountKobo: -instruction.amountKobo, kind: .topUp), wallet: WK.balance())
        #expect(TransferVerdict.of(.success(topup), instruction: instruction, firstEverSend: true) == .unsettled(.unreadable))
        let incoming = TransferReceipt(activity: WK.activity(amountKobo: instruction.amountKobo), wallet: WK.balance())
        #expect(TransferVerdict.of(.success(incoming), instruction: instruction, firstEverSend: true) == .unsettled(.unreadable))
    }

    @Test("only a settled failure is money-not-moved; every unsettled one is unknown; there is no third state")
    func money() {
        let settled: [TransferFailure] = [.insufficientFunds, .recipientNotFound, .ownNumber, .invalidDetails(message: "x", fields: [:]), .notRecorded]
        let unsettled: [TransferFailure] = [
            .interrupted, .noConnection, .serverProblem, .rateLimited(retryAfterSeconds: nil), .unreadable, .sessionEnded, .keyConflict,
            .refused(message: "x"),
        ]
        #expect(settled.allSatisfy { $0.money == .notMoved && $0.isSettled })
        #expect(unsettled.allSatisfy { $0.money == .unknown && !$0.isSettled })
        // Every verdict the table can produce agrees.
        for row in Self.table {
            for verdict in [row.2, row.3] {
                switch verdict {
                case .settled(let failure): #expect(failure.money == .notMoved, "\(row.0)")
                case .unsettled(let failure): #expect(failure.money == .unknown, "\(row.0)")
                case .sent: Issue.record("\(row.0): a failure is not a success")
                }
            }
        }
    }
}

@Suite("Wallet copy: honesty about the money")
struct WalletCopyTests {
    private let attempt = WK.attempt()

    private static let everyFailure: [TransferFailure] = [
        .insufficientFunds, .recipientNotFound, .ownNumber, .invalidDetails(message: "Bad.", fields: [:]),
        .invalidDetails(message: "Bad.", fields: [.amount: "Too small"]), .notRecorded,
        .interrupted, .noConnection, .serverProblem, .rateLimited(retryAfterSeconds: 90), .rateLimited(retryAfterSeconds: nil),
        .unreadable, .sessionEnded, .keyConflict, .refused(message: "Because."),
    ]

    @Test("'No money was taken' is said for a settled failure and for NO other", arguments: everyFailure)
    func noMoneyOnlyWhenProven(_ failure: TransferFailure) {
        let text = WalletCopy.failure(failure, attempt: attempt)
        let all = [text.heading, text.body, text.moneyLine, text.nextStep].joined(separator: " ").lowercased()
        switch failure.money {
        case .notMoved:
            #expect(text.moneyLine == WalletCopy.noMoneyTaken)
        case .unknown:
            #expect(text.moneyLine == WalletCopy.unknownMoneyLine)
            #expect(!all.contains("no money"), "\(failure)")
            #expect(!all.contains("not taken") && !all.contains("wasn't taken") && !all.contains("unchanged"), "\(failure)")
            #expect(text.moneyLine.contains("Check Recent activity before paying again"))
        }
    }

    @Test("every failure names what went wrong, says what to do, and never leaves a field empty", arguments: everyFailure)
    func complete(_ failure: TransferFailure) {
        let text = WalletCopy.failure(failure, attempt: attempt)
        for part in [text.heading, text.body, text.moneyLine, text.nextStep] { #expect(!part.isEmpty, "\(failure)") }
    }

    @Test("an unknown outcome says it could not confirm the payment, and tells the sender where to look")
    func unknownWording() {
        let text = WalletCopy.failure(.noConnection, attempt: attempt)
        #expect(text.heading == "We couldn't confirm your payment")
        #expect(text.moneyLine == "We couldn't confirm the payment. Check Recent activity before paying again.")
    }

    @Test("the recipient is the phone number, in every sentence that names one; a QR name never appears")
    func numberNotName() {
        let named = WK.attempt(payeeName: "Chidi Okeke (verified)")
        for failure in Self.everyFailure {
            let text = WalletCopy.failure(failure, attempt: named)
            let all = [text.heading, text.body, text.moneyLine, text.nextStep].joined(separator: " ")
            #expect(!all.contains("Chidi"), "\(failure)")
        }
        #expect(WalletCopy.summary(named) == "₦1,500 to 0803 123 4567")
        #expect(WalletCopy.unfinishedBody(named).contains("0803 123 4567"))
        #expect(!WalletCopy.unfinishedBody(named).contains("Chidi"))
        #expect(WalletCopy.discardMessage(named).contains("0803 123 4567"))
        #expect(WalletCopy.qrNameLabel == "Name in the QR code (not verified)")
    }

    @Test("a rate limit says when to try again")
    func rateLimit() {
        #expect(WalletCopy.failure(.rateLimited(retryAfterSeconds: 90), attempt: attempt).body.contains("Try again in 2 minutes."))
    }

    @Test("the amount is shown as naira from integer kobo")
    func amount() {
        #expect(WalletCopy.amount(WK.attempt(instruction: WK.instruction(amountKobo: 150_050))) == "₦1,500.50")
        #expect(WalletCopy.failure(.insufficientFunds, attempt: attempt).body.contains("₦1,500"))
    }

    @Test("the balance after a replay is never called 'your balance'")
    func replayBalanceLine() {
        let receipt = WK.receipt(balanceKobo: 4_850_000)
        let first = WalletCopy.balanceLine(receipt, replayed: false)
        let replay = WalletCopy.balanceLine(receipt, replayed: true)
        #expect(first.hasPrefix("Your balance is ₦48,500"))
        #expect(replay.contains("Your balance then was ₦48,500"))
        #expect(!replay.contains("Your balance is"))
        #expect(replay.contains("as of"))
    }

    @Test("activity wording survives the smallest Int: no trap, still 'out'")
    func activityIntMin() {
        let item = WK.activity(amountKobo: Int.min)
        #expect(WalletCopy.activitySpoken(item).contains("out"))
        #expect(!WalletCopy.activitySpoken(item).contains("minus"), "the direction is said once, in words")
        #expect(WalletCopy.activityAmount(item).hasPrefix("-"))
        let max = WK.activity(amountKobo: Int.max)
        #expect(WalletCopy.activitySpoken(max).contains("in"))
    }

    @Test("the balance as spoken includes a problem reading it, which the screen shows beside it")
    func balanceSpoken() {
        let balance = WK.balance(4_850_000)
        let plain = WalletCopy.balanceSpoken(balance, hasLoaded: true, problem: nil)
        #expect(plain.hasPrefix("Wallet balance, 48,500 naira, as of"))
        #expect(!plain.contains("Couldn't update"))
        let problem = WalletCopy.balanceSpoken(balance, hasLoaded: true, problem: .noConnection)
        #expect(problem.hasPrefix("Wallet balance, 48,500 naira, as of"))
        #expect(problem.contains(WalletCopy.readProblem(.noConnection, what: "your balance")))
        let none = WalletCopy.balanceSpoken(nil, hasLoaded: true, problem: .serverProblem)
        #expect(none.hasPrefix("Wallet balance not available"))
        #expect(none.contains("Couldn't update your balance"))
        #expect(WalletCopy.balanceSpoken(nil, hasLoaded: false, problem: nil) == "Loading wallet balance")
    }

    @Test("every block has a heading, a body and a next step; none says nothing was sent or that no money moved")
    func blocks() {
        // A saved attempt is written BEFORE its request leaves, so wherever storage cannot be read or cleared the
        // payment was almost certainly sent. None of these screens may say otherwise, in any of its four lines.
        let forbidden = ["nothing has been sent", "nothing was sent", "not been sent", "no money"]
        for block in [SendBlock.unreadable, .undecodable, .cannotClear, .obligationUnreadable, .resetFailed] {
            let text = WalletCopy.blocked(block)
            for part in [text.heading, text.body, text.moneyLine, text.nextStep] {
                #expect(!part.isEmpty)
                for phrase in forbidden { #expect(!part.lowercased().contains(phrase), "\(block): \(part)") }
            }
            #expect(text.moneyLine.contains("may"), "\(block) must say a payment MAY have been started")
            #expect(text.nextStep.contains("Recent activity"), "\(block) sends the person to Recent activity")
        }
        #expect(WalletCopy.blocked(.unreadable).moneyLine == "A payment may already have been started.")
    }

    @Test("activity rows: direction, sign and a spoken form")
    func activityRows() {
        let out = WK.activity(amountKobo: -150_000, counterparty: "Ada Obi", note: "Rent")
        let received = WK.activity("pst_2", amountKobo: 250_000, counterparty: "Chidi Okeke")
        let topUp = WK.activity("pst_3", amountKobo: 1_000_000, counterparty: nil, kind: .topUp)
        #expect(WalletCopy.activityTitle(out) == "Sent to Ada Obi")
        #expect(WalletCopy.activityAmount(out) == "-₦1,500")
        #expect(WalletCopy.activityTitle(received) == "Received from Chidi Okeke")
        #expect(WalletCopy.activityAmount(received) == "+₦2,500")
        #expect(WalletCopy.activityTitle(topUp) == "Top-up")
        #expect(WalletCopy.activitySpoken(out).hasPrefix("Sent to Ada Obi, 1,500 naira out"))
        #expect(WalletCopy.activitySpoken(out).hasSuffix("note: Rent"))
        #expect(WalletCopy.activitySpoken(received).contains("2,500 naira in"))
        #expect(WalletCopy.activityTitle(WK.activity(counterparty: nil)) == "Sent to another wallet")
    }
}
