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
public struct KobolinkAPIClient: Sendable, AuthServing, CheckoutServing {
    let client: Client

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
            // Innermost, so it reads the response before any caller-supplied middleware does.
            middlewares: middlewares + [ResponseNotesMiddleware()]
        )
    }

    /// Fifteen seconds, matching the Android client; no cache, no cookies,
    /// no credentials stored by URLSession.
    ///
    /// `waitsForConnectivity` is off on purpose: with it on, a login sent while offline would sit and
    /// go out whenever the network came back, possibly minutes later and after the person has given
    /// up. A failed call is shown, and the person decides to try again. URLSession does not resend a
    /// POST on its own, and nothing in this client does either.
    public static func makeSessionConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.waitsForConnectivity = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCredentialStorage = nil
        return configuration
    }

    /// The session every API call runs on. It REFUSES EVERY REDIRECT (`RedirectRefusingDelegate`): the
    /// API never redirects, so a 3xx is a misconfigured proxy or someone else's server, and following it
    /// would carry the request (a payer's name and email, a merchant's bearer token, a login password)
    /// to wherever the `Location` header points. A refused redirect is the 3xx response itself, which
    /// the client reads as `unexpectedResponse`: for a payment, an outcome that is unknown.
    ///
    /// `configuration` is a parameter so tests can add a `URLProtocol`.
    public static func makeSession(configuration: URLSessionConfiguration = makeSessionConfiguration()) -> URLSession {
        URLSession(configuration: configuration, delegate: RedirectRefusingDelegate(), delegateQueue: nil)
    }

    public static func makeURLSessionTransport() -> URLSessionTransport {
        URLSessionTransport(configuration: .init(session: makeSession()))
    }

    // MARK: - Calls

    /// `GET /api/health`: succeeds only when the API and its database answer.
    public func health() async throws(APIError) {
        let (output, notes) = try await perform { try await client.getHealth(.init()) }
        switch output {
        case .ok: return
        case .default(let status, let response):
            throw APIError(status: status, error: try? response.body.json, notes: notes)
        }
    }

    /// `GET /api/links/{code}/public`: what a customer sees before paying.
    /// `amountKobo` is `nil` for an open-amount link; money is whole kobo.
    public func publicLink(code: String) async throws(APIError) -> PublicLinkResponse {
        let (output, notes) = try await perform {
            try await client.resolvePublicLink(.init(path: .init(code: code)))
        }
        switch output {
        case .ok(let response):
            do { return try response.body.json } catch { throw .undecodableResponse }
        case .default(let status, let response):
            throw APIError(status: status, error: try? response.body.json, notes: notes)
        }
    }

    /// `GET /api/links/{code}/public` as the checkout reads it: the link and whether it can be paid.
    public func lookupLink(code: LinkCode) async throws(APIError) -> LinkLookup {
        let response = try await publicLink(code: code.value)
        guard let lookup = response.checkoutLookup else { throw .undecodableResponse }
        return lookup
    }

    /// `POST /api/checkout/initialize`. Sends no `Authorization` header and no cookie (a payer is not
    /// the merchant signed in on this phone), and exactly one request: nothing here or below retries.
    ///
    /// Read the result by what each case lets the caller conclude (`APIError`): a `.server` refusal
    /// answers THIS request and proves nothing about an earlier send of the same key unless it is one
    /// the idempotency layer stores (see `CheckoutController`).
    public func initializeCheckout(
        _ request: InitializeRequest,
        idempotencyKey: String
    ) async throws(APIError) -> StartedCheckout {
        let (output, notes) = try await perform {
            try await client.initializeCheckout(
                .init(
                    headers: .init(Idempotency_hyphen_Key: idempotencyKey),
                    body: .json(
                        .init(
                            amountKobo: request.amountKobo,
                            code: request.code.value,
                            payerEmail: request.payerEmail,
                            payerName: request.payerName
                        ))
                ))
        }
        switch output {
        case .created(let response):
            let body: Components.Schemas.InitializeCheckoutResponse
            do { body = try response.body.json } catch { throw .undecodableResponse }
            guard let started = StartedCheckout(body) else { throw .undecodableResponse }
            return started
        case .default(let status, let response):
            throw APIError(status: status, error: try? response.body.json, notes: notes)
        }
    }

    /// `POST /api/auth/login` as a mobile client, which is the only kind that receives the token in
    /// the body. Sends no `Authorization` header (see `AuthMiddleware`).
    ///
    /// Never print or log the result of this call or anything it throws internally: the generated
    /// request and response types hold the password and the token.
    public func login(email: String, password: String) async throws(APIError) -> AuthSession {
        let (output, notes) = try await perform {
            try await client.login(.init(body: .json(.init(client: .mobile, email: email, password: password))))
        }
        switch output {
        case .ok(let response):
            let body: Components.Schemas.AuthResponse
            do { body = try response.body.json } catch { throw .undecodableResponse }
            return AuthSession(user: body.user.signedInUser, token: body.token.flatMap(SessionToken.init))
        case .default(let status, let response):
            throw APIError(status: status, error: try? response.body.json, notes: notes)
        }
    }

    /// `GET /api/auth/me`: the signed-in user for the token the middleware attaches.
    public func currentUser() async throws(APIError) -> SignedInUser {
        let (output, notes) = try await perform { try await client.getMe(.init()) }
        switch output {
        case .ok(let response):
            do { return try response.body.json.user.signedInUser } catch { throw .undecodableResponse }
        case .default(let status, let response):
            throw APIError(status: status, error: try? response.body.json, notes: notes)
        }
    }

    /// `POST /api/auth/logout`, authenticated by `token` itself.
    public func logout(revoking token: SessionToken) async throws(APIError) {
        let (output, notes) = try await perform {
            try await AuthMiddleware.withToken(token) { try await client.logout(.init()) }
        }
        switch output {
        case .noContent: return
        case .default(let status, let response):
            throw APIError(status: status, error: try? response.body.json, notes: notes)
        }
    }

    // MARK: - Error mapping

    /// Runs one generated call and folds everything the runtime can throw into
    /// an `APIError`.
    ///
    /// The returned `ResponseNotes` holds what the response carried that the models do not (the
    /// `Retry-After` of a 429); it is bound to this call alone.
    func perform<T: Sendable>(
        _ call: () async throws -> T
    ) async throws(APIError) -> (T, ResponseNotes) {
        let notes = ResponseNotes()
        do {
            let output = try await ResponseNotes.$current.withValue(notes) { try await call() }
            return (output, notes)
        } catch {
            throw APIError(thrown: error)
        }
    }
}

extension APIError {
    /// A `.default` response from the generated client: an error status
    /// and, when the body decoded, the contracts' `ApiError`.
    init(status: Int, error: Components.Schemas.ApiError?, notes: ResponseNotes) {
        // `default` also catches statuses the document does not list, including a stray 2xx or 3xx. An
        // `ApiError`-shaped body does not make those a refusal: the server did not refuse anything.
        guard status >= 400 else {
            self = (200..<300).contains(status) ? .undecodableResponse : .unexpectedResponse(status: status)
            return
        }
        if let error {
            self = .server(ServerError(status: status, body: error, retryAfterSeconds: notes.retryAfterSeconds))
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

/// Refuses every redirect, so the 3xx itself is the final response. See `KobolinkAPIClient.makeSession`.
final class RedirectRefusingDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
