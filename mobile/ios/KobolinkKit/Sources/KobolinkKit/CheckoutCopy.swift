import Foundation

/// Everything the checkout says when it cannot let the payer pay, in one place and free of UI types so a
/// test can pin each sentence. The non-payable deck mirrors `NON_PAYABLE_COPY` in
/// `apps/web/src/lib/checkout.ts`: the web page and the app must not say it two different ways.
///
/// Every failure names what happened, says whether money moved, and offers the next step
/// (docs/DESIGN-SPEC.md). The money line is only ever a statement the app can back:
///
/// - "No money has moved." is said when nothing was started (a lookup, which moves nothing), when a
///   parsed server refusal says so, or when the device refused to record the attempt and nothing was sent.
/// - It is NEVER said about an attempt whose outcome is unknown. There the copy says it cannot be
///   confirmed and tells the payer to check before paying again.
public struct Notice: Equatable, Sendable {
    public let heading: String
    public let body: String?
    public let moneyLine: String
    public let nextStep: String

    public init(heading: String, body: String?, moneyLine: String, nextStep: String) {
        self.heading = heading
        self.body = body
        self.moneyLine = moneyLine
        self.nextStep = nextStep
    }
}

public enum CheckoutCopy {
    public static let noMoneyMoved = "No money has moved."

    // MARK: Non-payable states (mirrors the web)

    public static func notice(for availability: LinkAvailability, link: CheckoutLink) -> Notice {
        let merchant = link.merchantName
        switch availability {
        case .disabled:
            return Notice(
                heading: "This link is turned off",
                body: "\(merchant) has switched this payment link off.",
                moneyLine: noMoneyMoved,
                nextStep: "Ask \(merchant) for a new link, or check back later."
            )
        case .expired:
            return Notice(
                heading: "This link has expired",
                body: link.expiresAt.map { "This payment link expired on \(formatDate($0))." } ?? "This payment link has expired.",
                moneyLine: noMoneyMoved,
                nextStep: "Ask \(merchant) for a new link."
            )
        case .alreadyPaid:
            return Notice(
                heading: "This link has already been paid",
                body: "This is a single-use link and it has already been used.",
                moneyLine: noMoneyMoved,
                nextStep: "If you were expecting to pay just now, contact \(merchant) to confirm your payment or request a new link."
            )
        case .unknown, .payable:
            // A refusal that did not say why: state only what is known, never invent a merchant action.
            return Notice(
                heading: "This link cannot be paid right now",
                body: nil,
                moneyLine: noMoneyMoved,
                nextStep: "Please try again in a moment."
            )
        }
    }

    // MARK: Not found, load failed

    public static let notFound = Notice(
        heading: "We couldn't find this link",
        body: "Nothing matches it. It may have been copied in part, or it may no longer exist.",
        moneyLine: noMoneyMoved,
        nextStep: "Ask whoever sent it to share the link again."
    )

    public static func loadFailed(_ failure: LoadFailure) -> Notice {
        let body: String
        switch failure {
        case .noConnection: body = "Your iPhone couldn't reach Kobolink. Check your connection."
        case .rateLimited(let seconds): body = "Kobolink is getting too many requests from this iPhone. " + RetryDelay.sentence(seconds: seconds)
        case .serverProblem: body = "Kobolink had a problem on its side."
        case .unreadable: body = "Kobolink answered with something this version of the app can't read. If this keeps happening, update the app."
        }
        // Looking a link up never starts a payment, so this is a fact, not a hope.
        return Notice(heading: "Couldn't load this link", body: body, moneyLine: noMoneyMoved, nextStep: "Try again.")
    }

    /// Secure storage would not say, or would not let go. A saved attempt was almost certainly SENT (it is written
    /// before the request leaves), so this never says nothing was sent: it says one may have been started and
    /// to check with the merchant before paying again.
    public static func storageBlocked(_ block: StorageBlock) -> Notice {
        let body: String
        let nextStep: String
        switch block {
        case .unreadable:
            body = "Kobolink couldn't check this iPhone's secure storage for a payment you may already have started on this link."
            nextStep = "Unlock your iPhone and try again. Check with the merchant before paying again."
        case .undecodable:
            body = "A payment on this link was saved by a different version of Kobolink, and this version can't read it."
            nextStep = "Check with the merchant before paying again. Starting a new payment forgets the saved one."
        case .undecodableClearFailed:
            body = "A payment on this link was saved by a different version of Kobolink. This iPhone wouldn't let Kobolink forget it, so nothing has changed."
            nextStep = "Try again in a moment. Check with the merchant before paying again."
        case .cannotClear:
            body = "A payment saved on this iPhone by an earlier sign-in couldn't be removed, so it isn't shown here."
            nextStep = "Try again in a moment. Check with the merchant before paying again."
        case .obligationUnreadable:
            body = "Kobolink couldn't read the record of which saved payments to forget on this iPhone, so it can't tell which ones are safe to show."
            nextStep = "Check with the merchant before paying again. Resetting checkout data forgets every payment saved on this iPhone."
        case .resetFailed:
            body = "This iPhone wouldn't let Kobolink finish forgetting the saved checkout data."
            nextStep = "Try again in a moment. Check with the merchant before paying again."
        }
        return Notice(
            heading: "Can't open this payment yet", body: body,
            moneyLine: "A payment may already have been started on this link.", nextStep: nextStep)
    }

    // MARK: A remembered attempt

    /// "Payment started": the M3-to-M4 hand-off. `initialize` answered with a reference; `verify` (feature I4)
    /// is what decides the outcome, and until it exists the app says so plainly.
    public static let startedHeading = "Payment started"
    public static let startedMoneyLine = "No money has moved yet. This version of the app can't confirm the payment."
    public static let startedNextStep = "You can close this screen. Your reference is saved on this iPhone."

    public static let unsettledHeading = "We couldn't confirm your payment"

    public static func unsettledBody(_ reason: Unsettled) -> String {
        switch reason {
        case .interrupted:
            return "A payment on this iPhone was started earlier and Kobolink never saw how it ended."
        case .noConnection:
            return "Your iPhone lost its connection before Kobolink answered."
        case .serverProblem:
            return "Kobolink had a problem on its side before it answered."
        case .rateLimited(let seconds):
            return "Kobolink is getting too many requests from this iPhone. " + RetryDelay.sentence(seconds: seconds)
        case .unreadable:
            return "Kobolink answered with something this version of the app can't read."
        case .refused(let message):
            return "Kobolink answered: \(message)"
        }
    }

    /// The line in the box: what is and is not known. It does not say money did or did not move.
    public static let unsettledStatus = "We can't tell whether this payment started."

    /// What goes under it.
    public static func unsettledNextStep(merchant: String) -> String {
        "Try Again sends the same request, so it can't start a second payment. Check with \(merchant) before paying again."
    }

    public static let sendingHeading = "Starting your payment"
    public static let sendingNextStep = "Keep this screen open. This is the same request as before, so it can't start a second payment."

    /// The attempt could not be recorded, so nothing was sent.
    public static let notRecorded =
        "We couldn't save this payment securely on your iPhone, so we didn't start it. No money was taken. "
        + "Try again; if it keeps happening, restart your iPhone."

    public static let startOverFailed =
        "We couldn't clear this payment from your iPhone, so nothing has changed. Try again; if it keeps happening, restart Kobolink."

    public static func startOverTitle() -> String { "Start a new payment?" }

    /// Said before signing out when a payment was started on this iPhone and not finished. Neutral about WHO started
    /// it: a different person may have adopted an attempt that was made before their session was known.
    public static let signOutWarning =
        "A payment on this iPhone was started and not finished. Signing out forgets it here. If you already paid, check with the merchant first."

    /// The sign-out did not happen: what it must clear could not be written down first, so the person is still signed in.
    public static let signOutBlockedTitle = "Couldn't sign out safely"
    public static let signOutBlocked =
        "Kobolink couldn't prepare this iPhone to forget the payments saved here, so you're still signed in. Try again in a moment."

    public static let resetTitle = "Reset checkout data?"
    public static let resetMessage =
        "This forgets every payment saved on this iPhone, and anything a sign-out still owed. If you already paid, check with the merchant first."

    public static func startOverMessage(reference: String?, merchant: String) -> String {
        let what = reference.map { "payment \($0)" } ?? "the unfinished payment"
        return "This forgets \(what) on this iPhone and starts again. If you already paid, check with \(merchant) first."
    }

    // MARK: Refusals and price

    /// A first-send validation refusal. The fields carry the detail; the server's own message for them is
    /// the unhelpful "Validation failed.".
    public static func rejection(message: String, hasFieldErrors: Bool) -> String {
        (hasFieldErrors ? "Check the highlighted fields." : message) + " " + noMoneyMoved
    }

    public static func priceChanged(newAmountKobo: Int) -> String {
        "The price of this link is now \(Kobo.formatNaira(newAmountKobo)). Check it, then pay again. \(noMoneyMoved)"
    }

    // MARK: Pay button

    /// "Pay ₦18,500" once the amount is known, so the figure is on the control that spends it.
    public static func payButtonTitle(fixedAmountKobo: Int?, typedAmount: String) -> String {
        let amount = fixedAmountKobo ?? Kobo.parseNaira(typedAmount).flatMap { Kobo.isValidAmountKobo($0) ? $0 : nil }
        return amount.map { "Pay \(Kobo.formatNaira($0))" } ?? "Pay"
    }

    public static func payButtonSpoken(fixedAmountKobo: Int?, typedAmount: String) -> String {
        let amount = fixedAmountKobo ?? Kobo.parseNaira(typedAmount).flatMap { Kobo.isValidAmountKobo($0) ? $0 : nil }
        return amount.map { "Pay \(Kobo.spokenNaira($0))" } ?? "Pay"
    }

    /// "kbl_ab3d" read letter by letter, which is how a reference is quoted to a merchant.
    public static func spelledOut(_ reference: String) -> String {
        reference.map { $0 == "_" ? "underscore" : String($0) }.joined(separator: " ")
    }

    // MARK: Dates

    /// "7 Oct 2026, 18:00 WAT": exactly what `formatCheckoutDate` in `apps/web/src/lib/checkout.ts` writes
    /// (`Intl`, `en-NG`, `Africa/Lagos`, 24-hour, September as "Sept"). Pinned to Lagos and to the zone's own
    /// name rather than the phone's zone: a payer abroad would otherwise read a Lagos deadline as local time.
    /// The pieces are written out, not left to ICU, so a newer system's abbreviations cannot drift from the web's.
    public static func formatDate(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Africa/Lagos") ?? TimeZone(secondsFromGMT: 3600)!
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"]
        let hour = parts.hour ?? 0, minute = parts.minute ?? 0
        return "\(parts.day ?? 1) \(months[(parts.month ?? 1) - 1]) \(parts.year ?? 1970), "
            + "\(hour < 10 ? "0" : "")\(hour):\(minute < 10 ? "0" : "")\(minute) WAT"
    }
}
