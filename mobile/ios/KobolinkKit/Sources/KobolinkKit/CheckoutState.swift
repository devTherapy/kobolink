import Foundation

/// What the checkout screen is showing. The screen renders this and nothing else; every decision is in
/// `CheckoutController`.
public enum CheckoutScreen: Equatable, Sendable {
    /// No link open.
    case idle
    /// Looking the link up. Rendered as a skeleton in the shape of the content.
    case loading(LinkCode)
    /// The server said the code names no link (a parsed `not_found`).
    case notFound(LinkCode)
    /// The lookup could not be answered. Nothing is known about the link, and no payment was started.
    case loadFailed(LinkCode, LoadFailure)
    /// Secure storage would not tell us, or would not let go of, an earlier attempt for this link, so the
    /// link cannot be paid until it does: guessing could send a second payment or show someone else's.
    case storageBlocked(LinkCode, StorageBlock)
    /// The link, and whether it can be paid.
    case link(LinkScreen)
    /// A payment attempt that is remembered for this link and has no final answer yet: being sent or confirmed,
    /// or of unknown outcome.
    case attempt(AttemptScreen)
    /// How a payment ended, as the server decided it: paid, failed, or a link that could not take it.
    case result(ResultScreen)

    public var code: LinkCode? {
        switch self {
        case .idle: nil
        case .loading(let code), .notFound(let code), .loadFailed(let code, _), .storageBlocked(let code, _): code
        case .link(let screen): screen.link.code
        case .attempt(let screen): screen.code
        case .result(let screen): screen.code
        }
    }
}

/// Why a lookup failed.
public enum LoadFailure: Equatable, Sendable {
    case noConnection
    case rateLimited(retryAfterSeconds: Int?)
    case serverProblem
    /// The reply was not something this version of the app can read.
    case unreadable
}

public enum StorageBlock: Equatable, Sendable {
    /// The Keychain could not be read.
    case unreadable
    /// There is a record for this link that this build cannot read. Starting a new payment removes it.
    case undecodable
    /// "Start a New Payment" was confirmed on an unreadable record and storage would not remove it: nothing changed.
    case undecodableClearFailed
    /// The record of what a sign-out owes could not be read (it is there, and this build cannot make sense of it).
    /// Nothing may be shown until it is known, so the only way out is to reset the checkout data on this device.
    case obligationUnreadable
    /// "Reset checkout data" was confirmed and storage would not let go: nothing changed.
    case resetFailed
    /// A record belonging to an earlier session could not be removed, so it is not shown.
    case cannotClear
}

public struct LinkScreen: Equatable, Sendable {
    public var link: CheckoutLink
    public var availability: LinkAvailability
    public var pay: PayPhase

    public init(link: CheckoutLink, availability: LinkAvailability, pay: PayPhase = .editing) {
        self.link = link
        self.availability = availability
        self.pay = pay
    }
}

/// Where the Pay button is. Pay only ever calls `initialize`; verifying the payment is feature I4.
public enum PayPhase: Equatable, Sendable {
    case editing
    /// The first request is in flight (or about to be). The form is read-only and a second tap is ignored.
    case submitting
    /// The server refused the details on the first send (`validation_failed`). The form stays so they can
    /// be corrected; the refusal is definitive because the server checks them before it records anything.
    case rejected(message: String)
    /// A fixed-amount link was repriced after this screen loaded; this is the price from a fresh read.
    /// (When the fresh read fails the screen is `loadFailed`, which offers no Pay: the amount that was
    /// just refused is never offered again before a read succeeds.)
    case priceChanged(newAmountKobo: Int)
    /// The device could not record the attempt, so NOTHING WAS SENT. This is the one case where "no money
    /// was taken" is a fact about this tap rather than a claim about an earlier one: there is no earlier one.
    case notRecorded

    public var isBusy: Bool {
        if case .submitting = self { true } else { false }
    }
}

public struct AttemptScreen: Equatable, Sendable {
    public var code: LinkCode
    public var merchantName: String
    public var title: String
    /// What was asked for, in kobo; or what the server echoed once it answered.
    public var amountKobo: Int
    /// The server's reference once `initialize` answered. `nil` means the outcome is unknown.
    public var reference: String?
    public var phase: AttemptPhase
    /// "Start a new payment" was confirmed and storage would not let go of the record: nothing changed.
    public var startOverFailed: Bool

    public init(
        code: LinkCode,
        merchantName: String,
        title: String,
        amountKobo: Int,
        reference: String?,
        phase: AttemptPhase,
        startOverFailed: Bool = false
    ) {
        self.code = code
        self.merchantName = merchantName
        self.title = title
        self.amountKobo = amountKobo
        self.reference = reference
        self.phase = phase
        self.startOverFailed = startOverFailed
    }
}

public enum AttemptPhase: Equatable, Sendable {
    /// The request is being sent (the first send, or the same request again under the same key).
    case sending
    /// The outcome of the SEND is not known, so there is no reference. "Try again" resends the SAME request
    /// under the SAME key.
    case unsettled(Unsettled)
    /// `initialize` answered with a reference and `verify` is being asked, or is about to be asked again.
    /// `stillProcessing` is true after a `verify` answer that said the payment is not decided yet.
    case verifying(stillProcessing: Bool)
    /// There is a reference and `verify` has not given an answer that decides it. "Check Again" asks again; it
    /// cannot start a second payment, because a reference is decided once.
    case unconfirmed(Unconfirmed)
}

/// Why a started payment has no decided outcome yet. None of these says money did or did not move, except
/// `stillProcessing`, which is the server saying the payment is not decided (and so no money has moved yet).
public enum Unconfirmed: Equatable, Sendable {
    /// The server answered `pending`, and the bounded automatic checks are used up.
    case stillProcessing
    /// No usable answer: offline, a timeout, a dropped connection, a TLS failure.
    case noConnection
    /// A 5xx or an error page.
    case serverProblem
    /// A 429.
    case rateLimited(retryAfterSeconds: Int?)
    /// An answer this version of the app cannot read, a redirect, a 401, or a reply about some other payment.
    case unreadable
    /// The server refused in a way that decides nothing about this payment (a refusal that applies to the
    /// request, not to the checkout: a validation error, a replay mismatch).
    case refused(message: String)
}

/// How a payment ended, and what to say about it. Shown from the attempt's slot, so it reads the same after
/// Back, a relaunch and with no connection. It carries no name or email: there is nowhere to put them.
public struct ResultScreen: Equatable, Sendable {
    public var code: LinkCode
    public var merchantName: String
    public var title: String
    public var amountKobo: Int
    public var reference: String
    public var result: PaymentResult
    /// "Try Again" was pressed and storage would not let go of the finished payment: nothing changed.
    public var actionFailed: Bool

    public init(
        code: LinkCode, merchantName: String, title: String, amountKobo: Int, reference: String,
        result: PaymentResult, actionFailed: Bool = false
    ) {
        self.code = code
        self.merchantName = merchantName
        self.title = title
        self.amountKobo = amountKobo
        self.reference = reference
        self.result = result
        self.actionFailed = actionFailed
    }
}

/// Why an attempt's outcome is unknown. None of these is proof the request did nothing.
public enum Unsettled: Equatable, Sendable {
    /// Restored from storage: it was sent in an earlier run of the app (or the app was closed first) and
    /// nobody saw how it ended.
    case interrupted
    /// No usable answer: offline, a timeout, a dropped connection, a TLS failure.
    case noConnection
    /// A 5xx or an error page.
    case serverProblem
    /// A 429. The request may or may not have reached the handler.
    case rateLimited(retryAfterSeconds: Int?)
    /// An answer this version of the app cannot read, a redirect, or a reference that is not one.
    case unreadable
    /// The server refused the request in a way that does not settle it (anything but the three refusals
    /// the idempotency layer stores, and a validation error on the very first send): a refusal that
    /// applies only to a replay (a 401, a validation error) says nothing about whether the first send
    /// posted, so the attempt is kept and the message is shown with that caveat.
    case refused(message: String)
}
