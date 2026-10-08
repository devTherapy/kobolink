import Foundation

/// What a failed-payment screen says: what went wrong, whether money moved (always its own line), and what to do.
public struct FailureText: Equatable, Sendable {
    public let heading: String
    public let body: String
    public let moneyLine: String
    public let nextStep: String

    public init(heading: String, body: String, moneyLine: String, nextStep: String) {
        self.heading = heading
        self.body = body
        self.moneyLine = moneyLine
        self.nextStep = nextStep
    }
}

/// Everything the wallet says, in one place and free of UI types so a test can pin each sentence.
///
/// Every failure names what happened, says whether money moved, and offers the next step (docs/DESIGN-SPEC.md).
/// The money line is only ever a statement the app can back:
///
/// - "No money was taken." is said only when a parsed server refusal proves it, or when this device never sent the
///   request (`TransferFailure.money == .notMoved`).
/// - It is NEVER said about an attempt whose outcome is unknown. There the copy says the payment could not be
///   confirmed and tells the sender to check Recent activity before paying again.
///
/// The recipient is always the PHONE NUMBER. A name from a scanned code is whatever its creator wrote: it is shown
/// separately, labelled, and never stands in for the number.
public enum WalletCopy {
    public static let noMoneyTaken = "No money was taken. Your balance is unchanged."
    public static let unknownMoneyLine = "We couldn't confirm the payment. Check Recent activity before paying again."

    /// Said beside a name that came from a scanned code.
    public static let qrNameLabel = "Name in the QR code (not verified)"
    public static let qrNameWarning = "Anyone can put any name on a code. Check the phone number."

    // MARK: Who and how much

    /// "0803 123 4567".
    public static func recipient(_ attempt: TransferAttempt) -> String { NigerianPhone.display(attempt.instruction.toPhone) }

    public static func amount(_ attempt: TransferAttempt) -> String { Kobo.formatNaira(attempt.instruction.amountKobo) }

    public static func summary(_ attempt: TransferAttempt) -> String { "\(amount(attempt)) to \(recipient(attempt))" }

    // MARK: Failures

    public static func failure(_ failure: TransferFailure, attempt: TransferAttempt) -> FailureText {
        let amount = amount(attempt)
        let who = recipient(attempt)
        let summary = "\(amount) to \(who)"

        switch failure {
        // MARK: Settled
        case .insufficientFunds:
            return FailureText(
                heading: "Not enough money in your wallet",
                body: "Your wallet doesn't hold \(amount) to send to \(who).",
                moneyLine: noMoneyTaken,
                nextStep: "Send a smaller amount. Your balance is on the wallet screen.")
        case .recipientNotFound:
            return FailureText(
                heading: "No wallet for that number",
                body: "Kobolink has no wallet registered to \(who).",
                moneyLine: noMoneyTaken,
                nextStep: "Check the number, or ask them to join Kobolink.")
        case .ownNumber:
            return FailureText(
                heading: "That's your own number",
                body: "You can't send money to yourself.",
                moneyLine: noMoneyTaken,
                nextStep: "Enter someone else's phone number.")
        case .invalidDetails(let message, let fields):
            return FailureText(
                heading: "Kobolink couldn't accept those details",
                body: fields.isEmpty ? message : "Check the details you entered.",
                moneyLine: noMoneyTaken,
                nextStep: "Fix the highlighted fields, then review again.")
        case .notRecorded:
            return FailureText(
                heading: "We couldn't send this payment",
                body: "This iPhone wouldn't save the payment securely before sending it, so \(summary) was not sent.",
                moneyLine: noMoneyTaken,
                nextStep: "Try again. If it keeps happening, restart your iPhone.")

        // MARK: Unsettled
        case .interrupted:
            return unknown(
                body: "A payment of \(summary) was started earlier and Kobolink never saw how it ended.")
        case .noConnection:
            return unknown(body: "Your iPhone lost its connection while sending \(summary), before Kobolink answered.")
        case .serverProblem:
            return unknown(body: "Kobolink had a problem on its side while sending \(summary), before it answered.")
        case .rateLimited(let seconds):
            return unknown(
                body: "Kobolink is getting too many requests from this iPhone. " + RetryDelay.sentence(seconds: seconds))
        case .unreadable:
            return unknown(body: "Kobolink answered the payment of \(summary) with something this version of the app can't read.")
        case .keyConflict:
            return unknown(
                body: "Kobolink says a payment with different details was already started with this reference.",
                nextStep: "Look in Recent activity. If the payment isn't there, choose I Checked: It Didn't Go Through.")
        case .refused(let message):
            return unknown(body: "Kobolink answered: \(message)")
        case .sessionEnded:
            return FailureText(
                heading: "You've been signed out",
                body: "Your session ended while \(summary) was being sent.",
                moneyLine: unknownMoneyLine,
                nextStep: "Sign in again. This payment will be waiting here. Try Again sends the same request, so it can't pay twice.")
        }
    }

    private static func unknown(body: String, nextStep: String? = nil) -> FailureText {
        FailureText(
            heading: "We couldn't confirm your payment",
            body: body,
            moneyLine: unknownMoneyLine,
            nextStep: nextStep ?? "Try Again sends the same request, so it can't pay twice. If Recent activity shows it, you're done.")
    }

    /// What the sent screen says about the balance. A replay's answer is the stored original, so it is worded as a
    /// past balance with its time and is never called "your balance".
    public static func balanceLine(_ receipt: TransferReceipt, replayed: Bool) -> String {
        let amount = Kobo.formatNaira(receipt.wallet.balanceKobo)
        let time = CheckoutCopy.formatDate(receipt.wallet.asOf)
        if replayed {
            return "This payment had already gone through. Your balance then was \(amount), as of \(time). Your wallet is being updated."
        }
        return "Your balance is \(amount), as of \(time)."
    }

    public static let sendingHeading = "Sending your payment"
    public static let sendingNextStep = "Keep this screen open until Kobolink answers."
    public static let replayingNextStep = "This is the same request as before, so it can't pay twice. Keep this screen open."

    // MARK: Review

    public static let reviewFooter = "This sends the money straight away. It can't be taken back."

    // MARK: Discarding an unresolved payment

    public static let discardTitle = "Did the payment go through?"
    public static func discardMessage(_ attempt: TransferAttempt) -> String {
        "Only choose this if Recent activity does not show \(summary(attempt)). "
            + "If it went through and you send again, the recipient is paid twice."
    }

    public static let discardFailed =
        "We couldn't clear this payment from your iPhone, so nothing has changed. Try again; if it keeps happening, restart Kobolink."

    // MARK: The unfinished-payment banner on the wallet home

    public static func unfinishedHeading() -> String { "A payment didn't finish" }
    public static func unfinishedBody(_ attempt: TransferAttempt) -> String {
        "\(summary(attempt)). We couldn't confirm it, and it may not have gone through."
    }

    // MARK: Storage blocks

    public static func blocked(_ block: SendBlock) -> FailureText {
        switch block {
        case .unreadable:
            return FailureText(
                heading: "Can't check for an unfinished payment",
                body: "Kobolink couldn't read this iPhone's secure storage, so it can't tell whether a payment you started is waiting.",
                moneyLine: "Nothing has been sent.",
                nextStep: "Unlock your iPhone and try again. Check Recent activity before paying again.")
        case .undecodable:
            return FailureText(
                heading: "Can't open an unfinished payment",
                body: "A payment was saved on this iPhone by a different version of Kobolink, and this version can't read it.",
                moneyLine: "A payment may have been started.",
                nextStep: "Check Recent activity. Forgetting it lets you send again.")
        case .cannotClear:
            return FailureText(
                heading: "Can't open the wallet's payments yet",
                body: "A saved payment from an earlier sign-out couldn't be removed, so it isn't shown.",
                moneyLine: "A payment may have been started.",
                nextStep: "Try again in a moment. Check Recent activity before paying again.")
        case .obligationUnreadable:
            return FailureText(
                heading: "Can't open the wallet's payments yet",
                body: "Kobolink couldn't read the record of which saved payments to forget on this iPhone, so it can't tell which ones are safe to show.",
                moneyLine: "A payment may have been started.",
                nextStep: "Check Recent activity. Forgetting saved payments lets you send again.")
        case .resetFailed:
            return FailureText(
                heading: "Couldn't forget the saved payments",
                body: "This iPhone wouldn't let Kobolink finish forgetting them.",
                moneyLine: "A payment may have been started.",
                nextStep: "Try again in a moment. Check Recent activity before paying again.")
        }
    }

    public static let forgetTitle = "Forget saved payments?"
    public static let forgetMessage =
        "This forgets every unfinished payment saved on this iPhone. If one went through and you send again, the recipient is paid twice. Check Recent activity first."

    // MARK: Sign-out

    /// Said before signing out when a payment was started on this iPhone and not finished. Neutral about who
    /// started it, and about whether it was a checkout or a wallet payment.
    public static let signOutWarningWallet =
        "A payment on this iPhone was started and not finished. Signing out forgets it here, and this iPhone can no longer check it for you. Look at Recent activity first."

    public static func signOutWarning(checkout: Bool, wallet: Bool) -> String {
        switch (checkout, wallet) {
        case (true, false): CheckoutCopy.signOutWarning
        case (false, true): signOutWarningWallet
        default:
            "Payments on this iPhone were started and not finished. Signing out forgets them here. If you already paid, check Recent activity and with the merchant first."
        }
    }

    // MARK: Activity

    public static func activityTitle(_ item: WalletActivity) -> String {
        switch item.kind {
        case .transfer:
            let other = item.counterparty ?? "another wallet"
            return item.amountKobo < 0 ? "Sent to \(other)" : "Received from \(other)"
        case .topUp:
            return "Top-up"
        case .linkPayment:
            return item.amountKobo < 0 ? "Link payment" : "Payment received"
        }
    }

    /// "-₦1,500" or "+₦1,500". The sign is part of the text so colour is never the only signal.
    public static func activityAmount(_ item: WalletActivity) -> String {
        item.amountKobo < 0 ? Kobo.formatNaira(item.amountKobo) : "+" + Kobo.formatNaira(item.amountKobo)
    }

    public static func activitySpoken(_ item: WalletActivity) -> String {
        let money = Kobo.spokenNaira(abs(item.amountKobo))
        let direction = item.amountKobo < 0 ? "out" : "in"
        let note = item.note.map { ", note: \($0)" } ?? ""
        return "\(activityTitle(item)), \(money) \(direction), \(CheckoutCopy.formatDate(item.createdAt))\(note)"
    }

    // MARK: Wallet reads

    public static func readProblem(_ problem: WalletReadProblem, what: String) -> String {
        switch problem {
        case .noConnection: "Couldn't update \(what): your iPhone couldn't reach Kobolink."
        case .rateLimited(let seconds): "Couldn't update \(what): too many requests. " + RetryDelay.sentence(seconds: seconds)
        case .serverProblem: "Couldn't update \(what): Kobolink had a problem on its side."
        case .unreadable: "Couldn't update \(what): Kobolink answered with something this version can't read."
        case .sessionEnded: "Couldn't update \(what): your session ended."
        }
    }
}
