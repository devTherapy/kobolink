import Foundation
import Testing

@testable import KobolinkKit

/// The words of every result. The link states are the web's `NON_PAYABLE_COPY`; paid and failed are the web's `PayForm`
/// (`apps/web/src/components/checkout/PayForm.tsx`); the rest are said only about what the server stated.
@Suite("Result copy")
struct CheckoutResultCopyTests {
    private func screen(_ result: PaymentResult, merchant: String = "Adebayo Stores") -> ResultScreen {
        ResultScreen(code: CK.codeA, merchantName: merchant, title: "Ankara Two-Piece Set", amountKobo: 1_850_000, reference: CK.reference, result: result)
    }

    private static let allResults: [PaymentResult] = [
        .paid, .declined(reason: "Card declined by the simulated gateway."), .declined(reason: nil),
        .linkExpired, .linkDisabled, .linkAlreadyPaid, .checkoutNotFound,
    ]

    @Test("paid, as the web says it: successful, money moved, and the reference to quote")
    func paid() {
        let notice = CheckoutCopy.result(screen(.paid))
        #expect(notice.heading == "Payment successful")
        #expect(notice.moneyLine == "Money moved. Your payment was successful.")
        #expect(notice.nextStep.contains("Quote the reference"))
        #expect(notice.nextStep.contains("Adebayo Stores"))
    }

    @Test("failed, as the web says it: the server's reason, verbatim, and 'No money moved.'")
    func declined() {
        let notice = CheckoutCopy.result(screen(.declined(reason: "Card declined by the simulated gateway.")))
        #expect(notice.heading == "Payment failed")
        #expect(notice.body == "Card declined by the simulated gateway.")
        #expect(notice.moneyLine == "No money moved.")
        #expect(notice.nextStep == "You can try again. If it keeps failing, contact Adebayo Stores.")
        #expect(CheckoutCopy.result(screen(.declined(reason: nil))).body == "The payment could not be completed.")
    }

    @Test("expired, disabled and already paid are the link deck word for word, with the server's 'no money moved'")
    func linkStates() {
        let link = CheckoutLink(code: CK.codeA, merchantName: "Adebayo Stores", title: "Ankara Two-Piece Set")
        #expect(CheckoutCopy.result(screen(.linkExpired)) == CheckoutCopy.notice(for: .expired, link: link))
        #expect(CheckoutCopy.result(screen(.linkDisabled)) == CheckoutCopy.notice(for: .disabled, link: link))
        #expect(CheckoutCopy.result(screen(.linkAlreadyPaid)) == CheckoutCopy.notice(for: .alreadyPaid, link: link))
        #expect(CheckoutCopy.result(screen(.linkAlreadyPaid)).heading == "This link has already been paid")
        #expect(CheckoutCopy.result(screen(.linkDisabled)).nextStep == "Ask Adebayo Stores for a new link, or check back later.")
        // The date is not known from a verify answer, so the web's no-date sentence is the one used.
        #expect(CheckoutCopy.result(screen(.linkExpired)).body == "This payment link has expired.")
    }

    @Test("no such checkout: names it, says no money moved, and says what to do")
    func notFound() {
        let notice = CheckoutCopy.result(screen(.checkoutNotFound))
        #expect(notice.heading == "We couldn't find this payment")
        #expect(notice.moneyLine == "No money has moved.")
        #expect(notice.nextStep.contains("start a new payment"))
        #expect(notice.nextStep.contains("quote your reference"))
    }

    @Test("every result names what happened, says whether money moved, and gives a next step; only paid says money moved")
    func everyResultIsComplete() {
        for result in Self.allResults {
            let notice = CheckoutCopy.result(screen(result))
            #expect(!notice.heading.isEmpty, "\(result)")
            #expect(!notice.moneyLine.isEmpty, "\(result)")
            #expect(!notice.nextStep.isEmpty, "\(result)")
            if result == .paid {
                #expect(notice.moneyLine.hasPrefix("Money moved."), "\(result)")
            } else {
                #expect(notice.moneyLine == "No money moved." || notice.moneyLine == "No money has moved.", "\(result)")
                #expect(!notice.moneyLine.contains("Money moved."), "\(result)")
                // A failure says what went wrong in its heading or its body.
                #expect(notice.heading.count > 10 && (notice.body?.isEmpty == false || notice.heading.contains("couldn't find")), "\(result)")
            }
        }
    }

    @Test("a result never says money did NOT move unless the server said so: each such case is a decided, parsed answer")
    func noMoneyIsOnlyForDecidedResults() {
        // `PaymentResult` has no case for "unknown": the only way to reach a result is a parsed, decided answer, and
        // `moneyMoved` is derived from the case. A case that said money moved without being `paid` could not exist.
        for result in Self.allResults { #expect(result.moneyMoved == (result == .paid)) }
    }

    // MARK: Not decided

    private static let reasons: [Unconfirmed] = [
        .stillProcessing, .noConnection, .serverProblem, .rateLimited(retryAfterSeconds: 14), .rateLimited(retryAfterSeconds: nil),
        .unreadable, .refused(message: "Key reused."),
    ]

    @Test("a payment that could not be confirmed says so, admits it cannot tell whether money moved, and never says it did not")
    func unconfirmedNeverClaims() {
        for reason in Self.reasons where reason != .stillProcessing {
            let words = [
                CheckoutCopy.unconfirmedHeading(reason), CheckoutCopy.unconfirmedBody(reason),
                CheckoutCopy.unconfirmedMoneyLine(reason), CheckoutCopy.unconfirmedNextStep(reason, merchant: "Adebayo Stores"),
            ].joined(separator: " ")
            #expect(CheckoutCopy.unconfirmedHeading(reason) == "We couldn't confirm your payment", "\(reason)")
            #expect(CheckoutCopy.unconfirmedMoneyLine(reason) == "We can't tell whether money moved.", "\(reason)")
            #expect(!words.lowercased().contains("no money"), "\(reason)")
            #expect(!words.lowercased().contains("nothing was charged"), "\(reason)")
            #expect(!words.contains("Money moved."), "\(reason)")
            #expect(words.contains("Check Again"), "\(reason)")
            #expect(words.contains("can't start a second payment"), "\(reason)")
            #expect(words.contains("Check with Adebayo Stores before paying again"), "\(reason)")
        }
    }

    @Test("still processing says what the server said (no money has moved YET) and what to do if it stays that way")
    func stillProcessing() {
        #expect(CheckoutCopy.unconfirmedHeading(.stillProcessing) == "Your payment is still processing")
        #expect(CheckoutCopy.unconfirmedMoneyLine(.stillProcessing) == "Kobolink says no money has moved yet.")
        #expect(CheckoutCopy.unconfirmedNextStep(.stillProcessing, merchant: "Adebayo Stores").contains("quote your reference"))
        #expect(CheckoutCopy.processingMoneyLine == "Kobolink says no money has moved yet.")
    }

    @Test("each reason is said in its own words, and a refusal is the server's own")
    func bodies() {
        #expect(CheckoutCopy.unconfirmedBody(.noConnection) == "Your iPhone couldn't reach Kobolink to confirm it.")
        #expect(CheckoutCopy.unconfirmedBody(.serverProblem) == "Kobolink had a problem on its side while confirming it.")
        #expect(CheckoutCopy.unconfirmedBody(.unreadable).contains("can't read"))
        #expect(CheckoutCopy.unconfirmedBody(.refused(message: "Key reused.")) == "Kobolink answered: Key reused.")
        #expect(CheckoutCopy.unconfirmedBody(.rateLimited(retryAfterSeconds: 14)).hasSuffix("Try again in 14 seconds."))
        #expect(Set(Self.reasons.map(CheckoutCopy.unconfirmedBody)).count == Self.reasons.count)
    }

    @Test("while it is being confirmed the screen claims nothing about the money")
    func verifying() {
        #expect(CheckoutCopy.verifyingHeading == "Confirming your payment")
        #expect(CheckoutCopy.verifyingMoneyLine == "Waiting for Kobolink to confirm.")
        #expect(!CheckoutCopy.verifyingMoneyLine.lowercased().contains("no money"))
        #expect(CheckoutCopy.verifyingNextStep.contains("can't start a second payment"))
        #expect(CheckoutCopy.processingHeading == "Still processing your payment")
    }

    @Test("copying the reference is named, and announced")
    func copying() {
        #expect(CheckoutCopy.copyReference == "Copy Reference")
        #expect(CheckoutCopy.referenceCopied == "Reference copied")
    }

    @Test("every failure of the whole checkout names what went wrong and says whether money moved, one way or another")
    func everyFailureSaysTheMoney() {
        // Looking a link up, sending, confirming, and every ending: the money line is one of these and nothing else.
        let allowed: Set<String> = [
            "No money has moved.", "No money moved.", "Money moved. Your payment was successful.",
            "We can't tell whether this payment started.", "We can't tell whether money moved.",
            "Kobolink says no money has moved yet.", "Waiting for Kobolink to confirm.",
            "A payment may already have been started on this link.",
        ]
        var lines: [String] = []
        lines += Self.allResults.map { CheckoutCopy.result(screen($0)).moneyLine }
        lines += Self.reasons.map(CheckoutCopy.unconfirmedMoneyLine)
        lines += [CheckoutCopy.unsettledStatus, CheckoutCopy.verifyingMoneyLine, CheckoutCopy.processingMoneyLine]
        lines += [LoadFailure.noConnection, .rateLimited(retryAfterSeconds: nil), .serverProblem, .unreadable].map { CheckoutCopy.loadFailed($0).moneyLine }
        lines += [StorageBlock.unreadable, .undecodable, .undecodableClearFailed, .cannotClear, .obligationUnreadable, .resetFailed].map { CheckoutCopy.storageBlocked($0).moneyLine }
        lines += [LinkAvailability.disabled, .expired, .alreadyPaid, .unknown].map { CheckoutCopy.notice(for: $0, link: CK.link()).moneyLine }
        lines += [CheckoutCopy.notFound.moneyLine]
        for line in lines { #expect(allowed.contains(line), "unexpected money line: \(line)") }
    }
}
