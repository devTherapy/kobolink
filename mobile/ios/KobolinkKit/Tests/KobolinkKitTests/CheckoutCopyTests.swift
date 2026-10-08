import Foundation
import Testing

@testable import KobolinkKit

/// The non-payable deck is `NON_PAYABLE_COPY` in `apps/web/src/lib/checkout.ts`, sentence for sentence.
@Suite("Checkout copy")
struct CheckoutCopyTests {
    private let link = CK.link(merchant: "Adebayo Stores")

    @Test("disabled, as the web says it")
    func disabled() {
        #expect(CheckoutCopy.notice(for: .disabled, link: link) == Notice(
            heading: "This link is turned off",
            body: "Adebayo Stores has switched this payment link off.",
            moneyLine: "No money has moved.",
            nextStep: "Ask Adebayo Stores for a new link, or check back later."))
    }

    @Test("expired, with the date in Lagos time, and without a date")
    func expired() {
        let withDate = CK.link(expiresAt: Date(timeIntervalSince1970: 1_791_392_400))  // 2026-10-07 17:00 UTC = 18:00 WAT
        let dated = CheckoutCopy.notice(for: .expired, link: withDate)
        #expect(dated.heading == "This link has expired")
        #expect(dated.body == "This payment link expired on 7 Oct 2026, 6:00 PM WAT.")
        #expect(dated.nextStep == "Ask Adebayo Stores for a new link.")
        #expect(dated.moneyLine == "No money has moved.")
        #expect(CheckoutCopy.notice(for: .expired, link: link).body == "This payment link has expired.")
    }

    @Test("already paid, as the web says it")
    func alreadyPaid() {
        #expect(CheckoutCopy.notice(for: .alreadyPaid, link: link) == Notice(
            heading: "This link has already been paid",
            body: "This is a single-use link and it has already been used.",
            moneyLine: "No money has moved.",
            nextStep: "If you were expecting to pay just now, contact Adebayo Stores to confirm your payment or request a new link."))
    }

    @Test("a refusal that did not say why is neutral: no merchant action is invented")
    func unknownReason() {
        let notice = CheckoutCopy.notice(for: .unknown, link: link)
        #expect(notice.heading == "This link cannot be paid right now")
        #expect(notice.body == nil)
        #expect(notice.nextStep == "Please try again in a moment.")
    }

    @Test("the date is Lagos time whatever the phone's zone")
    func dateZone() {
        let saved = NSTimeZone.default
        defer { NSTimeZone.default = saved }
        for zone in ["America/Los_Angeles", "Asia/Tokyo", "UTC"] {
            NSTimeZone.default = TimeZone(identifier: zone)!
            #expect(CheckoutCopy.formatDate(Date(timeIntervalSince1970: 1_791_392_400)) == "7 Oct 2026, 6:00 PM WAT")
        }
    }

    @Test("not found and load failed both say no money has moved, because looking a link up moves none")
    func noMoneyOnLookup() {
        #expect(CheckoutCopy.notFound.moneyLine == "No money has moved.")
        for failure in [LoadFailure.noConnection, .rateLimited(retryAfterSeconds: 14), .serverProblem, .unreadable] {
            let notice = CheckoutCopy.loadFailed(failure)
            #expect(notice.heading == "Couldn't load this link")
            #expect(notice.moneyLine == "No money has moved.")
            #expect(notice.nextStep == "Try again.")
        }
        #expect(CheckoutCopy.loadFailed(.rateLimited(retryAfterSeconds: 14)).body?.hasSuffix("Try again in 14 seconds.") == true)
    }

    @Test("an attempt of unknown outcome never says money did not move")
    func unsettledNeverClaims() {
        let reasons: [Unsettled] = [.interrupted, .noConnection, .serverProblem, .rateLimited(retryAfterSeconds: 5), .unreadable, .refused(message: "No.")]
        for reason in reasons {
            let words = [CheckoutCopy.unsettledHeading, CheckoutCopy.unsettledBody(reason), CheckoutCopy.unsettledStatus, CheckoutCopy.unsettledNextStep(merchant: "Adebayo Stores")].joined(separator: " ")
            #expect(!words.lowercased().contains("no money"), "\(reason)")
            #expect(!words.lowercased().contains("nothing was charged"), "\(reason)")
            #expect(words.contains("before paying again"), "\(reason)")
        }
        #expect(CheckoutCopy.unsettledBody(.refused(message: "Slow down.")) == "Kobolink answered: Slow down.")
    }

    @Test("'Payment started' says no money has moved YET and that this version cannot confirm it")
    func started() {
        #expect(CheckoutCopy.startedHeading == "Payment started")
        #expect(CheckoutCopy.startedMoneyLine == "No money has moved yet. This version of the app can't confirm the payment.")
    }

    @Test("a refusal's message adds the money line, and points at the fields when the server named some")
    func rejection() {
        #expect(CheckoutCopy.rejection(message: "Validation failed.", hasFieldErrors: true) == "Check the highlighted fields. No money has moved.")
        #expect(CheckoutCopy.rejection(message: "Idempotency-Key header is required.", hasFieldErrors: false) == "Idempotency-Key header is required. No money has moved.")
    }

    @Test("the price notice names the new price through Kobo, not arithmetic")
    func priceChanged() {
        #expect(CheckoutCopy.priceChanged(newAmountKobo: 2_000_050) == "The price of this link is now ₦20,000.50. Check it, then pay again. No money has moved.")
    }

    @Test("the Pay button names the amount once it is known, in text and aloud")
    func payButton() {
        #expect(CheckoutCopy.payButtonTitle(fixedAmountKobo: 1_850_000, typedAmount: "") == "Pay ₦18,500")
        #expect(CheckoutCopy.payButtonSpoken(fixedAmountKobo: 1_850_000, typedAmount: "") == "Pay 18,500 naira")
        #expect(CheckoutCopy.payButtonTitle(fixedAmountKobo: nil, typedAmount: "5,000") == "Pay ₦5,000")
        #expect(CheckoutCopy.payButtonTitle(fixedAmountKobo: nil, typedAmount: "5") == "Pay")
        #expect(CheckoutCopy.payButtonTitle(fixedAmountKobo: nil, typedAmount: "") == "Pay")
    }

    @Test("a reference is spelled out for VoiceOver")
    func spelling() {
        #expect(CheckoutCopy.spelledOut("kbl_aB3") == "k b l underscore a B 3")
    }

    @Test("the not-recorded and start-over-failed messages are honest about what happened")
    func storageMessages() {
        #expect(CheckoutCopy.notRecorded.contains("didn't start it"))
        #expect(CheckoutCopy.notRecorded.contains("No money was taken"))
        #expect(CheckoutCopy.startOverFailed.contains("nothing has changed"))
        #expect(!CheckoutCopy.startOverFailed.lowercased().contains("no money"))
    }
}
