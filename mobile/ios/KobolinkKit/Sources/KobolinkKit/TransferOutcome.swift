import Foundation

/// Whether the sender's money left the wallet, as far as this app can honestly say. There is no "moved" case:
/// a success is a `TransferReceipt`, not a failure.
public enum MoneyOutcome: Equatable, Sendable {
    /// Proven: the server refused inside its idempotency layer (the answer for this key, first send or replay), or
    /// this device never sent the request.
    case notMoved
    /// Not known. The request may have posted. Only the same request under the same key can find out.
    case unknown
}

/// The form fields a refusal can point at.
public enum SendField: Hashable, Sendable {
    case phone
    case amount
    case note

    /// The request field the server names in `ApiError.fields`.
    init?(wireName: String) {
        switch wireName {
        case "toPhone": self = .phone
        case "amountKobo": self = .amount
        case "note": self = .note
        default: return nil
        }
    }
}

/// Why a transfer did not come back as a success, and so what the sender may do about it.
///
/// The first group are SETTLED: money did not move and the attempt is over, so the sender may correct the details
/// and start a NEW payment under a NEW key. The second group are UNSETTLED: the first send may have posted. The
/// attempt and its key are kept, and the only ways forward are the same request under the same key or the
/// sender's confirmed "I checked: it didn't go through".
public enum TransferFailure: Equatable, Sendable {
    // MARK: Settled (`money == .notMoved`)

    /// `insufficient_funds`, stored under the key by the idempotency layer.
    case insufficientFunds
    /// `not_found` for the recipient's number, stored under the key.
    case recipientNotFound
    /// The number is the sender's own (`validation_failed` on `toPhone`, stored under the key).
    case ownNumber
    /// `validation_failed` on the very first send ever of this attempt: the server checks the body before it
    /// records anything. The fields carry the detail.
    case invalidDetails(message: String, fields: [SendField: String])
    /// This device would not write the attempt down, so the request was NOT SENT.
    case notRecorded

    // MARK: Unsettled (`money == .unknown`)

    /// Restored from storage: it was sent in an earlier run (or the screen was left) and nobody saw how it ended.
    case interrupted
    /// No usable answer: offline, a timeout, a dropped connection, a TLS failure.
    case noConnection
    /// A 5xx, or an error page.
    case serverProblem
    /// A 429. The request may or may not have reached the handler.
    case rateLimited(retryAfterSeconds: Int?)
    /// An answer this version cannot read, a redirect, a 2xx that is not a 201, or a receipt for some other payment.
    case unreadable
    /// A 401: the session ended. It answers THIS request only; whether the first send posted is not known.
    case sessionEnded
    /// `idempotency_mismatch`: the server says this key was used with other details. This app never changes a
    /// request under its key, so the stored attempt is not trusted either way.
    case keyConflict
    /// Any other refusal that is not one the idempotency layer stores.
    case refused(message: String)

    public var money: MoneyOutcome {
        switch self {
        case .insufficientFunds, .recipientNotFound, .ownNumber, .invalidDetails, .notRecorded:
            .notMoved
        case .interrupted, .noConnection, .serverProblem, .rateLimited, .unreadable, .sessionEnded, .keyConflict, .refused:
            .unknown
        }
    }

    public var isSettled: Bool { money == .notMoved }
}

/// What an answer to `POST /api/wallet/transfer` lets the app conclude about the attempt it belongs to.
///
/// This is the single place that decides whether an answer SETTLES an attempt, because that decision is where a
/// double payment would come from (Android's M5 was blocked three times on it): a refusal that applies only to the
/// REPLAY (a 401, a validation 400 on a retry, `idempotency_mismatch`) says nothing about whether the first send
/// posted.
///
/// The refusals that ARE the answer for a key, because `WalletService.decideTransfer` computes them inside
/// `IdempotencyService.run` and the layer stores them, so they come back identically to every replay:
/// - `not_found` 404 (no wallet for that number), `moneyMoved: false`;
/// - `insufficient_funds` 422, `moneyMoved: false`;
/// - `validation_failed` 400 for the sender's own number (`fields.toPhone`), `moneyMoved: false`.
///
/// Everything else the controller can say happens BEFORE the layer (the session guard, the body validation, the
/// missing-header check), is never stored, and so proves nothing about an earlier send; the one exception is the
/// body validation on the very first send ever, where there is no earlier send.
enum TransferVerdict: Equatable {
    case sent(TransferReceipt)
    /// A definitive refusal: the attempt is over and no money moved.
    case settled(TransferFailure)
    /// Not known. The attempt and its key are kept.
    case unsettled(TransferFailure)

    /// The sentence `WalletService.decideTransfer` writes into `fields.toPhone` for the sender's own number.
    static let ownNumberFieldMessage = "cannot transfer to yourself"

    static func of(
        _ result: Result<TransferReceipt, APIError>,
        instruction: TransferInstruction,
        firstEverSend: Bool
    ) -> TransferVerdict {
        switch result {
        case .success(let receipt):
            // A reply about some other payment is not an answer to this one.
            guard receipt.activity.kind == .transfer, receipt.activity.amountKobo == -instruction.amountKobo else {
                return .unsettled(.unreadable)
            }
            return .sent(receipt)

        case .failure(.server(let error)):
            if error.moneyMoved == false {
                switch (error.code, error.status) {
                case (.not_found, 404): return .settled(.recipientNotFound)
                case (.insufficient_funds, 422): return .settled(.insufficientFunds)
                case (.validation_failed, 400) where error.fieldErrors["toPhone"]?.contains(ownNumberFieldMessage) == true:
                    return .settled(.ownNumber)
                default: break
                }
            }
            if firstEverSend, error.code == .validation_failed, error.status == 400, error.moneyMoved != true {
                return .settled(invalid(error))
            }
            if error.isUnauthenticated { return .unsettled(.sessionEnded) }
            switch error.code {
            case .rate_limited:
                return .unsettled(.rateLimited(retryAfterSeconds: error.retryAfterSeconds))
            case .idempotency_mismatch:
                return .unsettled(.keyConflict)
            case ._internal:
                return .unsettled(.serverProblem)
            default:
                return error.status >= 500 ? .unsettled(.serverProblem) : .unsettled(.refused(message: error.message))
            }

        case .failure(.unexpectedResponse(let status)):
            if status == 401 { return .unsettled(.sessionEnded) }
            if status == 429 { return .unsettled(.rateLimited(retryAfterSeconds: nil)) }
            return .unsettled(status >= 500 ? .serverProblem : .unreadable)
        case .failure(.undecodableResponse):
            return .unsettled(.unreadable)
        case .failure(.unreachable), .failure(.cancelled):
            return .unsettled(.noConnection)
        }
    }

    private static func invalid(_ error: ServerError) -> TransferFailure {
        var fields: [SendField: String] = [:]
        for (name, messages) in error.fieldErrors {
            if let field = SendField(wireName: name), let first = messages.first { fields[field] = first }
        }
        return .invalidDetails(message: error.message, fields: fields)
    }
}
