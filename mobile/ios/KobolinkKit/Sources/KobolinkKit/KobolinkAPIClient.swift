import Foundation
import KobolinkAPI
import OpenAPIRuntime
import OpenAPIURLSession

/// The public link a customer is about to pay, as the API describes it.
public typealias PublicLinkResponse = Components.Schemas.PublicLinkResponse

/// The API, one typed call at a time. Wraps the generated `Client` (URLSession
/// underneath) so that every failure arrives as an `APIError`, and every
/// success is a generated model.
///
/// Only calls the app needs are surfaced. Each new one is three lines: invoke
/// the generated operation, return on its success case, throw
/// `APIError(status:error:)` on `.default`.
public struct KobolinkAPIClient: Sendable {
    private let client: Client

    /// `transport` is injectable so tests run the real generated
    /// serialisation and decoding against canned HTTP responses.
    public init(
        configuration: APIConfiguration,
        transport: any ClientTransport = KobolinkAPIClient.makeURLSessionTransport(),
        middlewares: [any ClientMiddleware] = []
    ) {
        self.client = Client(
            serverURL: configuration.baseURL,
            configuration: .init(dateTranscoder: TolerantISO8601DateTranscoder()),
            transport: transport,
            middlewares: middlewares
        )
    }

    /// Fifteen seconds, matching the Android client; no cache, no cookies,
    /// no credentials stored by URLSession.
    public static func makeURLSessionTransport() -> URLSessionTransport {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.waitsForConnectivity = false
        return URLSessionTransport(configuration: .init(session: URLSession(configuration: configuration)))
    }

    // MARK: - Calls

    /// `GET /api/health`: succeeds only when the API and its database answer.
    public func health() async throws(APIError) {
        let output = try await perform { try await client.getHealth(.init()) }
        switch output {
        case .ok: return
        case .default(let status, let response): throw APIError(status: status, error: try? response.body.json)
        }
    }

    /// `GET /api/links/{code}/public`: what a customer sees before paying.
    /// `amountKobo` is `nil` for an open-amount link; money is whole kobo.
    public func publicLink(code: String) async throws(APIError) -> PublicLinkResponse {
        let output = try await perform {
            try await client.resolvePublicLink(.init(path: .init(code: code)))
        }
        switch output {
        case .ok(let response):
            do { return try response.body.json } catch { throw .undecodableResponse }
        case .default(let status, let response): throw APIError(status: status, error: try? response.body.json)
        }
    }

    // MARK: - Error mapping

    /// Runs one generated call and folds everything the runtime can throw into
    /// an `APIError`.
    private func perform<T: Sendable>(_ call: () async throws -> T) async throws(APIError) -> T {
        do {
            return try await call()
        } catch {
            throw APIError(thrown: error)
        }
    }
}

extension APIError {
    /// A `.default` response from the generated client: an error status
    /// and, when the body decoded, the contracts' `ApiError`.
    fileprivate init(status: Int, error: Components.Schemas.ApiError?) {
        if let error {
            self = .server(ServerError(status: status, body: error))
        } else {
            self = .unexpectedResponse(status: status)
        }
    }

    /// Anything the generated client threw.
    init(thrown error: any Error) {
        if error is CancellationError { self = .cancelled; return }
        if let urlError = error as? URLError { self = Self(urlError: urlError); return }

        if let clientError = error as? ClientError {
            if let urlError = clientError.underlyingError as? URLError {
                self = Self(urlError: urlError)
            } else if clientError.underlyingError is CancellationError {
                self = .cancelled
            } else if let response = clientError.response {
                // The server answered, but the generated decoder rejected the
                // reply: not JSON, not an ApiError, a body that breaks the contract.
                self = (200..<300).contains(response.status.code)
                    ? .undecodableResponse
                    : .unexpectedResponse(status: response.status.code)
            } else {
                // Never got a response and it was not a URL error: the
                // transport failed in a way URLSession did not classify.
                self = .unreachable(.unknown)
            }
            return
        }
        self = .unreachable(.unknown)
    }

    private init(urlError: URLError) {
        self = urlError.code == .cancelled ? .cancelled : .unreachable(urlError.code)
    }
}
