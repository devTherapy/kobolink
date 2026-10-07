import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import KobolinkKit

private enum Wire {
    static let user = """
        {"id":"usr_test01","role":"merchant","email":"merchant@example.test","phone":null,\
        "displayName":"Test Merchant","createdAt":"2026-01-02T03:04:05.000Z"}
        """
    static let session = "{\"id\":\"ses_test01\",\"expiresAt\":\"2026-02-02T03:04:05.000Z\"}"

    static func loginOK(token: String? = Fixture.tokenA.reveal()) -> String {
        let tokenPart = token.map { ",\"token\":\"\($0)\"" } ?? ""
        return "{\"user\":\(user),\"session\":\(session)\(tokenPart)}"
    }

    static let me = "{\"user\":\(user)}"
}

private struct Rig {
    let transport: StubTransport
    let store: InMemoryTokenStore
    let relay = SessionRejectionRelay()
    let rejected = RejectionLog()
    let client: KobolinkAPIClient

    init(
        _ transport: StubTransport,
        token: SessionToken? = nil,
        store: InMemoryTokenStore? = nil,
        middlewareBaseURL: String = "https://pay.example.test"
    ) {
        self.transport = transport
        self.store = store ?? InMemoryTokenStore(token: token)
        let log = rejected
        relay.handler = { log.append($0) }
        client = KobolinkAPIClient(
            configuration: APIConfiguration(baseURL: URL(string: "https://pay.example.test")!),
            transport: transport,
            middlewares: [
                AuthMiddleware(baseURL: URL(string: middlewareBaseURL)!, tokenStore: self.store, relay: relay)
            ]
        )
    }

    var sent: [RequestRecorder.Entry] { transport.recorder.all }
}

private final class RejectionLog: @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [SessionToken] = []
    func append(_ token: SessionToken) {
        lock.lock()
        tokens.append(token)
        lock.unlock()
    }
    var all: [SessionToken] {
        lock.lock()
        defer { lock.unlock() }
        return tokens
    }
}

@Suite("Auth requests: what goes on the wire")
struct AuthRequestTests {
    @Test("login POSTs the email, the password and client: mobile as JSON to /api/auth/login")
    func loginRequest() async throws {
        let rig = Rig(.json(Wire.loginOK()))
        _ = try await rig.client.login(email: Fixture.email, password: Fixture.password)
        let sent = try #require(rig.sent.first)
        #expect(sent.request.method == .post)
        #expect(sent.request.path == "/api/auth/login")
        #expect(sent.operationID == "login")
        let json = try #require(JSONSerialization.jsonObject(with: Data(sent.bodyText.utf8)) as? [String: String])
        #expect(json == ["email": Fixture.email, "password": Fixture.password, "client": "mobile"])
        #expect(sent.request.headerFields[.contentType]?.hasPrefix("application/json") == true)
    }

    @Test("login carries no Authorization header, even with a token in the store")
    func loginHasNoCredentialHeader() async throws {
        let rig = Rig(.json(Wire.loginOK()), token: Fixture.tokenB)
        _ = try await rig.client.login(email: Fixture.email, password: Fixture.password)
        #expect(try #require(rig.sent.first).request.headerFields[.authorization] == nil)
    }

    @Test("login returns the user and the token for the Keychain")
    func loginResult() async throws {
        let session = try await Rig(.json(Wire.loginOK())).client.login(email: Fixture.email, password: Fixture.password)
        #expect(session.user == Fixture.user)
        #expect(session.token == Fixture.tokenA)
    }

    @Test("a 200 without a token, or with one that cannot be a header value, has no token")
    func loginWithoutUsableToken() async throws {
        for body in [Wire.loginOK(token: nil), Wire.loginOK(token: "has a space"), Wire.loginOK(token: "")] {
            let session = try await Rig(.json(body)).client.login(email: Fixture.email, password: Fixture.password)
            #expect(session.token == nil)
            #expect(session.user == Fixture.user)
        }
    }

    @Test("public calls (a payer's link lookup, the health check) carry no token either")
    func publicCallsHaveNoHeader() async throws {
        let link = Rig(.json(Payloads.publicLink), token: Fixture.tokenA)
        _ = try await link.client.publicLink(code: "aBcDeFgH")
        #expect(try #require(link.sent.first).request.headerFields[.authorization] == nil)
        let health = Rig(.json("{\"status\":\"ok\"}"), token: Fixture.tokenA)
        try await health.client.health()
        #expect(try #require(health.sent.first).request.headerFields[.authorization] == nil)
    }

    @Test("me carries the stored token as a bearer")
    func meCarriesBearer() async throws {
        let rig = Rig(.json(Wire.me), token: Fixture.tokenA)
        let user = try await rig.client.currentUser()
        #expect(user == Fixture.user)
        let sent = try #require(rig.sent.first)
        #expect(sent.request.path == "/api/auth/me")
        #expect(sent.request.method == .get)
        #expect(sent.request.headerFields[.authorization] == "Bearer \(Fixture.tokenA.reveal())")
    }

    @Test("a token saved after the client was built is used from the next call")
    func tokenPickedUpLater() async throws {
        let rig = Rig(.json(Wire.me))
        _ = try await rig.client.currentUser()
        try rig.store.saveToken(Fixture.tokenB)
        _ = try await rig.client.currentUser()
        #expect(rig.sent[0].request.headerFields[.authorization] == nil)
        #expect(rig.sent[1].request.headerFields[.authorization] == "Bearer \(Fixture.tokenB.reveal())")
        try rig.store.clearToken()
        _ = try await rig.client.currentUser()
        #expect(rig.sent[2].request.headerFields[.authorization] == nil, "a cleared token is not sent again")
    }

    @Test("signed out, no Authorization header is sent")
    func signedOutSendsNoHeader() async throws {
        let rig = Rig(.json(Wire.me))
        _ = try await rig.client.currentUser()
        #expect(rig.sent.first?.request.headerFields[.authorization] == nil)
    }

    @Test("an unreadable store sends the request without a bearer instead of throwing")
    func unreadableStore() async throws {
        let store = InMemoryTokenStore(token: Fixture.tokenA)
        store.fail(.read)
        let rig = Rig(.json(Wire.me), store: store)
        _ = try await rig.client.currentUser()
        #expect(rig.sent.first?.request.headerFields[.authorization] == nil)
    }

    @Test("the token is never sent to an origin other than the configured API")
    func otherOriginGetsNothing() async throws {
        let rig = Rig(.json(Wire.me), token: Fixture.tokenA, middlewareBaseURL: "https://elsewhere.example.test")
        _ = try await rig.client.currentUser()
        #expect(rig.sent.first?.request.headerFields[.authorization] == nil)
    }

    @Test("the origin check ignores case and an explicit default port")
    func originEquivalence() async throws {
        let rig = Rig(.json(Wire.me), token: Fixture.tokenA, middlewareBaseURL: "https://PAY.example.test:443")
        _ = try await rig.client.currentUser()
        #expect(rig.sent.first?.request.headerFields[.authorization] != nil)
    }

    @Test("logout authenticates with the token it is given, even when the store is already empty")
    func logoutUsesExplicitToken() async throws {
        let rig = Rig(StubTransport(reply: .respond(status: 204, contentType: nil, body: "")))
        try await rig.client.logout(revoking: Fixture.tokenA)
        let sent = try #require(rig.sent.first)
        #expect(sent.request.method == .post)
        #expect(sent.request.path == "/api/auth/logout")
        #expect(sent.request.headerFields[.authorization] == "Bearer \(Fixture.tokenA.reveal())")
        // The override ends with the call: a later request goes back to the (empty) store.
        _ = await failure { try await rig.client.currentUser() }  // the 204 is not a /me body; only the header matters
        #expect(rig.sent.last?.request.headerFields[.authorization] == nil)
    }
}

@Suite("Auth responses: errors and 401 handling")
struct AuthResponseTests {
    private func apiError(_ code: String, _ message: String, extra: String = "") -> String {
        Payloads.apiError(code, message, extra: extra)
    }

    @Test("a 401 to an authenticated request reports the token that was rejected")
    func rejectionReported() async throws {
        let body = apiError("unauthenticated", "Sign in to continue.")
        let rig = Rig(.json(body, status: 401), token: Fixture.tokenA)
        let error = await failure { try await rig.client.currentUser() }
        #expect(error?.isUnauthenticated == true)
        #expect(rig.rejected.all == [Fixture.tokenA])
    }

    @Test("a 401 to LOGIN is a wrong password and reports no rejection")
    func loginUnauthorised() async throws {
        let body = apiError("unauthenticated", "Incorrect email or password.")
        let rig = Rig(.json(body, status: 401), token: Fixture.tokenA)
        let error = await failure { try await rig.client.login(email: Fixture.email, password: "wrong") }
        #expect(error?.isUnauthenticated == true)
        #expect(rig.rejected.all.isEmpty)
    }

    @Test("a 401 to an unauthenticated request (no token) reports nothing")
    func noTokenNoRejection() async throws {
        let rig = Rig(.json(apiError("unauthenticated", "Sign in."), status: 401))
        _ = await failure { try await rig.client.currentUser() }
        #expect(rig.rejected.all.isEmpty)
    }

    @Test("success and other errors report no rejection")
    func otherStatuses() async throws {
        let ok = Rig(.json(Wire.me), token: Fixture.tokenA)
        _ = try await ok.client.currentUser()
        let down = Rig(.json(apiError("internal", "Something went wrong."), status: 500), token: Fixture.tokenA)
        _ = await failure { try await down.client.currentUser() }
        #expect(ok.rejected.all.isEmpty && down.rejected.all.isEmpty)
    }

    @Test("a 429 carries Retry-After seconds into the error")
    func retryAfter() async throws {
        var transport = StubTransport.json(apiError("rate_limited", "Too many login attempts. Try again later."), status: 429)
        transport.responseHeaders[.retryAfter] = "840"
        let error = await failure { try await Rig(transport).client.login(email: Fixture.email, password: "x") }
        guard case .server(let server)? = error else {
            Issue.record("expected a server error, got \(String(describing: error))")
            return
        }
        #expect(server.code == .rate_limited)
        #expect(server.status == 429)
        #expect(server.retryAfterSeconds == 840)
    }

    @Test("a 429 without Retry-After has none, and a malformed or dated one is ignored", arguments: [
        nil, "soon", "-5", "Wed, 21 Oct 2026 07:28:00 GMT", "", "1.5",
    ] as [String?])
    func retryAfterMissingOrOdd(header: String?) async throws {
        var transport = StubTransport.json(apiError("rate_limited", "Too many."), status: 429)
        if let header { transport.responseHeaders[.retryAfter] = header }
        let error = await failure { try await Rig(transport).client.login(email: Fixture.email, password: "x") }
        guard case .server(let server)? = error else {
            Issue.record("expected a server error")
            return
        }
        #expect(server.retryAfterSeconds == nil)
    }

    @Test("Retry-After is capped at a day")
    func retryAfterCap() {
        #expect(ResponseNotes.parseRetryAfter("99999999") == 86_400)
        #expect(ResponseNotes.parseRetryAfter(" 30 ") == 30)
    }

    @Test("two calls in flight do not see each other's Retry-After")
    func notesAreIsolated() async throws {
        var limited = StubTransport.json(apiError("rate_limited", "Too many."), status: 429)
        limited.responseHeaders[.retryAfter] = "60"
        let plain = StubTransport.json(apiError("unauthenticated", "No."), status: 401)
        async let a = failure { try await Rig(limited).client.login(email: "a@example.test", password: "x") }
        async let b = failure { try await Rig(plain).client.login(email: "b@example.test", password: "x") }
        let (first, second) = await (a, b)
        #expect(first.serverError?.retryAfterSeconds == 60)
        #expect(second.serverError?.retryAfterSeconds == nil)
    }

    @Test("validation errors keep their per-field messages")
    func validationFields() async throws {
        let body = apiError(
            "validation_failed", "Validation failed.",
            extra: ",\"fields\":{\"email\":[\"Invalid email address\"],\"password\":[\"Too short\"]}")
        let error = await failure { try await Rig(.json(body, status: 400)).client.login(email: "x", password: "y") }
        #expect(error.serverError?.fieldErrors["email"] == ["Invalid email address"])
        #expect(error.serverError?.fieldErrors["password"] == ["Too short"])
    }

    @Test("a failed login is sent exactly once: nothing resends it")
    func noSilentRetry() async throws {
        let transport = StubTransport(reply: .fail(URLError(.networkConnectionLost)))
        let error = await failure { try await Rig(transport).client.login(email: Fixture.email, password: Fixture.password) }
        #expect(error == .unreachable(.networkConnectionLost))
        #expect(transport.recorder.all.count == 1)

        let timeout = StubTransport(reply: .fail(URLError(.timedOut)))
        _ = await failure { try await Rig(timeout).client.login(email: Fixture.email, password: Fixture.password) }
        #expect(timeout.recorder.all.count == 1)
    }

    @Test("the URLSession does not wait for connectivity, keep cookies, credentials or a cache")
    func sessionConfiguration() {
        let configuration = KobolinkAPIClient.makeSessionConfiguration()
        #expect(configuration.waitsForConnectivity == false)
        #expect(configuration.timeoutIntervalForRequest == 15)
        #expect(configuration.httpShouldSetCookies == false)
        #expect(configuration.httpCookieAcceptPolicy == .never)
        #expect(configuration.httpCookieStorage == nil)
        #expect(configuration.urlCredentialStorage == nil)
        #expect(configuration.urlCache == nil)
    }

    @Test("what an error and a session print never contains the password or the token")
    func nothingSecretIsPrinted() async throws {
        let session = try await Rig(.json(Wire.loginOK())).client.login(email: Fixture.email, password: Fixture.password)
        let printed = [
            String(describing: session), String(reflecting: session), "\(session)",
            String(describing: session.token as Any), "\(Fixture.tokenA)", String(reflecting: Fixture.tokenA),
        ]
        var dumped = ""
        dump(session, to: &dumped)
        for text in printed + [dumped] {
            #expect(!text.contains(Fixture.tokenA.reveal()))
        }
        let error = await failure { try await Rig(StubTransport(reply: .fail(URLError(.timedOut)))).client.login(email: Fixture.email, password: Fixture.password) }
        let errorText = String(describing: error) + String(reflecting: error as Any)
        #expect(!errorText.contains(Fixture.password))
    }
}

extension Optional where Wrapped == APIError {
    fileprivate var serverError: KobolinkKit.ServerError? {
        if case .server(let error)? = self { return error }
        return nil
    }
}
