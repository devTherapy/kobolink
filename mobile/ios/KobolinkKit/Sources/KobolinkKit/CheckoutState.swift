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
    /// A payment attempt that is remembered for this link: started, or of unknown outcome.
    case attempt(AttemptScreen)

    public var code: LinkCode? {
        switch self {
        case .idle: nil
        case .loading(let code), .notFound(let code), .loadFailed(let code, _), .storageBlocked(let code, _): code
        case .link(let screen): screen.link.code
        case .attempt(let screen): screen.code
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
    /// `initialize` answered with a reference.
    case started
    /// The same request is being sent again under the same key.
    case sending
    /// The outcome is not known. "Try again" resends the SAME request under the SAME key.
    case unsettled(Unsettled)
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
