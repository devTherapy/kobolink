import Foundation
import KobolinkAPI

/// The `ApiError` code, as generated from the contracts.
public typealias ApiErrorCode = Components.Schemas.ApiError.codePayload

/// The server's refusal: an HTTP status plus the contracts' `ApiError` body.
public struct ServerError: Error, Equatable, Sendable {
    public let status: Int
    public let code: ApiErrorCode
    public let message: String
    /// Per-field validation messages (`validation_failed`).
    public let fieldErrors: [String: [String]]
    /// Present on money-moving refusals. `false` means the server says nothing
    /// was posted. `nil` means it did not say, which proves nothing either way.
    public let moneyMoved: Bool?
    /// Present on `link_not_payable`: why the link cannot take a payment.
    public let linkState: Components.Schemas.ApiError.statePayload?

    public init(
        status: Int,
        code: ApiErrorCode,
        message: String,
        fieldErrors: [String: [String]] = [:],
        moneyMoved: Bool? = nil,
        linkState: Components.Schemas.ApiError.statePayload? = nil
    ) {
        self.status = status
        self.code = code
        self.message = message
        self.fieldErrors = fieldErrors
        self.moneyMoved = moneyMoved
        self.linkState = linkState
    }

    init(status: Int, body: Components.Schemas.ApiError) {
        self.init(
            status: status,
            code: body.code,
            message: body.message,
            fieldErrors: body.fields?.additionalProperties ?? [:],
            moneyMoved: body.moneyMoved,
            linkState: body.state
        )
    }

    public var isUnauthenticated: Bool { status == 401 || code == .unauthenticated }
}

/// Every way an API call can fail, split by what the caller may conclude.
///
/// Each case speaks only for THE REQUEST THAT PRODUCED IT:
/// - `.server` is a definitive answer to that request. It is not proof that an
///   earlier attempt at the same payment did nothing: a refusal that applies
///   only to a replay (a 401, a validation 400) says nothing about whether the
///   first send posted.
/// - `.unreachable`, `.unexpectedResponse` and `.undecodableResponse` mean
///   "could not find out". The request may or may not have been applied.
///
/// Rules for any money-moving call built on this (I3 onward):
/// - Only `ServerError.moneyMoved == false`, or a reply that came back through
///   the idempotency layer for the same key, may clear a pending payment
///   attempt. A bare `.server` refusal may not.
/// - While an earlier attempt's outcome is unknown, a retry reuses the same
///   idempotency key. Never mint a new one.
/// - There is no silent transport retry: the person sees "could not find out"
///   and chooses to try again.
public enum APIError: Error, Equatable, Sendable {
    /// The server answered THIS request with a contracts `ApiError`. See the
    /// rules above before treating it as proof about an earlier attempt.
    case server(ServerError)
    /// An error status whose body is not a readable `ApiError` (a proxy's
    /// HTML 502, a code newer than this build knows).
    case unexpectedResponse(status: Int)
    /// A success status whose body does not match the contract.
    case undecodableResponse
    /// No usable answer: offline, timed out, TLS failure.
    case unreachable(URLError.Code)
    /// The call was cancelled by the caller.
    case cancelled
}

extension APIError {
    /// Plain-language text for the person using the app; nil when there is
    /// nothing to say (a cancelled call).
    public var userMessage: String? {
        switch self {
        case .server(let error): error.message
        case .unexpectedResponse(let status): "The server sent an unexpected reply (HTTP \(status)). Try again shortly."
        case .undecodableResponse: "The server's reply wasn't what this version of Kobolink expects. Update the app and try again."
        case .unreachable: "Can't reach the server. Check your connection and try again."
        case .cancelled: nil
        }
    }
}
