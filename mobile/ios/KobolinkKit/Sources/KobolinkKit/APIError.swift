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
/// The split is the point: `.server` is a definitive answer, `.unreachable` is
/// "could not find out" (the request may or may not have arrived), and the
/// two in between mean the server answered with something this app cannot
/// read. Callers that move money must not treat the last three as proof that
/// nothing happened.
public enum APIError: Error, Equatable, Sendable {
    /// The server answered with a contracts `ApiError`.
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
