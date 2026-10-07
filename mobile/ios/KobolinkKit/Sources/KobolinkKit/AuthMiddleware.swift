import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Where a 401 on an authenticated request is reported, from a networking thread to the session
/// layer on the main actor. The relay is built first and handed to `AuthMiddleware`; the
/// `SessionController` is created afterwards and installs `handler`.
public final class SessionRejectionRelay: @unchecked Sendable {
    private let lock = NSLock()
    private var storedHandler: (@Sendable (SessionToken) -> Void)?

    public init() {}

    /// Called with the token the server just rejected.
    public var handler: (@Sendable (SessionToken) -> Void)? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return storedHandler
        }
        set {
            lock.lock()
            defer { lock.unlock() }
            storedHandler = newValue
        }
    }

    func rejected(_ token: SessionToken) {
        handler?(token)
    }
}

/// Attaches `Authorization: Bearer <token>` to calls to the API, and reports a 401 that answers one.
///
/// This is the mobile half of what the API's session guard accepts (`apps/api/src/auth/extract-token.ts`:
/// a bearer header, or the web cookie).
///
/// - The token comes from the `TokenStore` on every request, so a token saved after the client was
///   built is used from the next call, and one cleared is not sent again.
/// - It is attached only when the request goes to the configured API origin (scheme, host and port).
///   The client is shared; without this, a future call to another host would carry the session.
/// - `login` and `registerUser` get no header: the person is presenting credentials, and an old,
///   possibly dead, token must not ride along (and a 401 there means "wrong password", not "session ended").
///   The public calls (`resolvePublicLink`, `getHealth`) get none either: a payer opening a link is
///   not the merchant who happens to be signed in on the same phone.
/// - A store that cannot be read sends the request without a header. The server's 401 then reads as
///   a signed-out call; nothing throws on a networking thread.
/// - A 401 to a request that carried a token calls `onRejected` with THAT token. The session layer
///   acts only if it is still the stored one, so a late 401 for an old token cannot sign out a newer session.
///
/// The token is never logged, and there is no logging in this type at all.
public struct AuthMiddleware: ClientMiddleware {
    private struct Origin: Equatable, Sendable {
        let scheme: String
        let host: String
        let port: Int

        init?(_ url: URL) {
            guard let scheme = url.scheme?.lowercased(), let host = url.host()?.lowercased() else { return nil }
            self.scheme = scheme
            self.host = host
            self.port = url.port ?? (scheme == "https" ? 443 : 80)
        }
    }

    /// Operations that get no `Authorization` header: the person is presenting credentials instead of a
    /// session (`login`, `registerUser`), or the call is public (a payer looks up a link, the health
    /// check) and a merchant's token has no business on it. A new public operation belongs here.
    static let withoutSession: Set<String> = ["login", "registerUser", "getHealth", "resolvePublicLink"]

    private let tokens: any TokenStore
    private let origin: Origin?
    private let onRejected: @Sendable (SessionToken) -> Void

    public init(
        baseURL: URL,
        tokenStore: any TokenStore,
        relay: SessionRejectionRelay
    ) {
        self.tokens = tokenStore
        self.origin = Origin(baseURL)
        self.onRejected = { relay.rejected($0) }
    }

    @TaskLocal private static var explicitToken: SessionToken?

    /// Run `operation` so that every API call it makes is authenticated by `token` instead of by the
    /// stored one. Used to revoke a session after its local copy is already gone.
    static func withToken<T: Sendable>(
        _ token: SessionToken,
        operation: () async throws -> T
    ) async rethrows -> T {
        try await $explicitToken.withValue(token, operation: operation)
    }

    public func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        guard !Self.withoutSession.contains(operationID),
            let origin, Origin(baseURL) == origin,
            let token = Self.explicitToken ?? (try? tokens.readToken())
        else {
            return try await next(request, body, baseURL)
        }

        var authenticated = request
        authenticated.headerFields[.authorization] = "Bearer \(token.reveal())"
        let (response, responseBody) = try await next(authenticated, body, baseURL)
        if response.status.code == 401 { onRejected(token) }
        return (response, responseBody)
    }
}

// MARK: - Response notes

/// What a call learned that the generated models do not carry. Today: `Retry-After`, which the API
/// sets on a 429 (`apps/api/src/auth/auth.controller.ts`) but the OpenAPI document does not declare,
/// so the generator drops it.
///
/// A fresh instance is bound to the task for the duration of one call (`KobolinkAPIClient.perform`),
/// so two calls in flight never see each other's headers.
final class ResponseNotes: @unchecked Sendable {
    private let lock = NSLock()
    private var storedRetryAfter: Int?

    var retryAfterSeconds: Int? {
        lock.lock()
        defer { lock.unlock() }
        return storedRetryAfter
    }

    func record(retryAfter seconds: Int) {
        lock.lock()
        defer { lock.unlock() }
        storedRetryAfter = seconds
    }

    @TaskLocal static var current: ResponseNotes?

    /// `Retry-After` is either whole seconds or an HTTP date. The API sends seconds; a date, a
    /// negative or a non-number is ignored rather than guessed at. Capped at a day.
    static func parseRetryAfter(_ raw: String) -> Int? {
        let text = raw.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty, text.utf8.allSatisfy({ (0x30...0x39).contains($0) }),
            let seconds = Int(text)
        else { return nil }
        return min(seconds, 86_400)
    }
}

struct ResponseNotesMiddleware: ClientMiddleware {
    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        let result = try await next(request, body, baseURL)
        if let raw = result.0.headerFields[.retryAfter], let seconds = ResponseNotes.parseRetryAfter(raw) {
            ResponseNotes.current?.record(retryAfter: seconds)
        }
        return result
    }
}
