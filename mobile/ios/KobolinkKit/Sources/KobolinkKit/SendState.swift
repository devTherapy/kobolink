import Foundation

/// What the person is about to send, before there is a key: the reviewed instruction and, if the number came from a
/// scanned code, the name that code carried (unverified).
public struct TransferDraft: Equatable, Sendable {
    public let instruction: TransferInstruction
    public let payeeName: String?

    public init(instruction: TransferInstruction, payeeName: String?) {
        self.instruction = instruction
        self.payeeName = payeeName
    }
}

/// Why the send flow cannot start. Guessing could send a second payment, or show someone else's.
public enum SendBlock: Equatable, Sendable {
    /// The Keychain could not be read, so it is not known whether an earlier payment is waiting.
    case unreadable
    /// A saved payment is there and this build cannot read it.
    case undecodable
    /// A saved payment from an earlier sign-out could not be removed, so it is not shown.
    case cannotClear
    /// The record of which saved payments to forget could not be read.
    case obligationUnreadable
    /// "Forget" was confirmed and storage would not let go: nothing changed.
    case resetFailed
}

/// What the send flow is showing. The screen renders this and nothing else; every decision is in `SendController`.
public enum SendScreen: Equatable, Sendable {
    /// Nothing open.
    case idle
    /// The camera.
    case scan
    /// The form.
    case form
    /// The review step: nothing has been sent, there is no key yet.
    case confirm(TransferDraft)
    /// The request is in flight. `replay` is a "Try again" of an earlier send, under the same key.
    case sending(TransferAttempt, replay: Bool)
    /// The server posted it. `replayed`: this is the stored ORIGINAL answer to an earlier send, so its balance and
    /// time are those of the moment it first posted.
    case sent(TransferAttempt, TransferReceipt, replayed: Bool)
    /// It did not come back as a success. `failure.money` says whether money moved.
    case failed(TransferAttempt, TransferFailure)
    /// Secure storage will not say whether an earlier payment is waiting.
    case blocked(SendBlock)

    /// The attempt whose outcome is not known, if this screen is it.
    var unresolvedAttempt: TransferAttempt? {
        switch self {
        case .sending(let attempt, _): attempt
        case .failed(let attempt, let failure) where !failure.isSettled: attempt
        default: nil
        }
    }
}
