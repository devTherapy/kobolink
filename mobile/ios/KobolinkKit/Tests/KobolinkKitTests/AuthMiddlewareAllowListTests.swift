import Foundation
import HTTPTypes
import OpenAPIRuntime
import OpenAPIURLSession
import Testing

@testable import KobolinkKit

/// The OpenAPI document is the authority on which operations are secured. `AuthMiddleware` carries the
/// token only to those, so a public operation, today's or one added next month, cannot carry a merchant's
/// bearer token on a payer's request.
@Suite("AuthMiddleware: only secured operations carry the session token")
struct AuthMiddlewareAllowListTests {
    private struct Operation {
        let id: String
        let method: String
        let path: String
        let secured: Bool
    }

    private static func operations() throws -> [Operation] {
        let thisFile = URL(fileURLWithPath: #filePath)
        let kit = thisFile.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        // A symlink to apps/api/openapi.json: the same file the generator reads.
        let url = kit.appendingPathComponent("Sources/KobolinkAPI/openapi.json")
        let document = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let globalSecurity = document["security"] as? [[String: Any]] ?? []
        let paths = try #require(document["paths"] as? [String: [String: Any]])
        var found: [Operation] = []
        for (path, item) in paths {
            for (method, value) in item {
                guard let operation = value as? [String: Any], let id = operation["operationId"] as? String else { continue }
                // An operation-level `security` replaces the global one, and an empty list means public.
                let security = operation["security"] as? [[String: Any]] ?? globalSecurity
                found.append(Operation(id: id, method: method, path: path, secured: !security.isEmpty))
            }
        }
        return found
    }

    @Test("the document is read, and has both secured and public operations (including both checkout calls)")
    func documentIsRead() throws {
        let operations = try Self.operations()
        #expect(operations.count >= 15)
        #expect(operations.contains { $0.secured } && operations.contains { !$0.secured })
        let byID = Dictionary(uniqueKeysWithValues: operations.map { ($0.id, $0) })
        for id in ["initializeCheckout", "verifyCheckout", "resolvePublicLink", "login", "registerUser", "getHealth"] {
            #expect(byID[id]?.secured == false, "\(id) should be public")
        }
        for id in ["getMe", "logout", "createLink", "getWallet"] {
            #expect(byID[id]?.secured == true, "\(id) should be secured")
        }
    }

    @Test("the allow-list is exactly the set of operations the document secures")
    func listMatchesDocument() throws {
        let secured = Set(try Self.operations().filter(\.secured).map(\.id))
        #expect(AuthMiddleware.securedOperations == secured,
            "missing: \(secured.subtracting(AuthMiddleware.securedOperations).sorted()), stale: \(AuthMiddleware.securedOperations.subtracting(secured).sorted())")
    }

    /// Run `operationID` through a real middleware holding a token, and report whether the request that
    /// reached the transport had an Authorization header.
    private static func carriesToken(_ operationID: String) async throws -> Bool {
        let store = InMemoryTokenStore(token: Fixture.tokenA)
        let middleware = AuthMiddleware(baseURL: URL(string: "https://pay.example.test")!, tokenStore: store, relay: SessionRejectionRelay())
        let request = HTTPRequest(method: .post, scheme: nil, authority: nil, path: "/x")
        let seen = Captured<String?>(nil)
        _ = try await middleware.intercept(request, body: nil, baseURL: URL(string: "https://pay.example.test")!, operationID: operationID) { sent, body, _ in
            seen.value = sent.headerFields[.authorization]
            return (HTTPResponse(status: .ok), body)
        }
        return seen.value != nil
    }

    @Test("for EVERY operation in the document, the token is attached exactly when it is secured")
    func everyOperation() async throws {
        for operation in try Self.operations() {
            let carries = try await Self.carriesToken(operation.id)
            #expect(carries == operation.secured, "\(operation.method.uppercased()) \(operation.path) (\(operation.id))")
        }
    }

    @Test("payer calls never carry a merchant's token: initialize, verify, link lookup, health")
    func payerCalls() async throws {
        for id in ["initializeCheckout", "verifyCheckout", "resolvePublicLink", "getHealth", "login", "registerUser"] {
            #expect(try await !Self.carriesToken(id), "\(id)")
        }
    }

    @Test("an operation nobody has heard of gets no token: the list fails closed, not open")
    func unknownOperation() async throws {
        #expect(try await !Self.carriesToken("someOperationAddedNextMonth"))
        #expect(try await !Self.carriesToken(""))
    }

    @Test("the token still goes to a secured operation, and only to the API's own origin")
    func securedStillWorks() async throws {
        #expect(try await Self.carriesToken("getMe"))
        let store = InMemoryTokenStore(token: Fixture.tokenA)
        let middleware = AuthMiddleware(baseURL: URL(string: "https://pay.example.test")!, tokenStore: store, relay: SessionRejectionRelay())
        let seen = Captured<String?>("untouched")
        _ = try await middleware.intercept(
            HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/x"), body: nil,
            baseURL: URL(string: "https://elsewhere.example.test")!, operationID: "getMe"
        ) { sent, body, _ in
            seen.value = sent.headerFields[.authorization]
            return (HTTPResponse(status: .ok), body)
        }
        #expect(seen.value == nil)
    }
}

/// Answers every request to `pay.example.test` with a redirect to somewhere else, and records every
/// request it is asked to load, so a test can see whether the redirect was followed.
final class RedirectingProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var loaded: [URLRequest] = []

    static var requests: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return loaded
    }

    static func reset() {
        lock.lock()
        loaded = []
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.loaded.append(request)
        Self.lock.unlock()
        guard let url = request.url else { return }
        if url.host == "pay.example.test" {
            let target = URL(string: "https://evil.example.test/collect")!
            let response = HTTPURLResponse(url: url, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: ["Location": target.absoluteString])!
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: target), redirectResponse: response)
            // If the session refuses the redirect, the 302 itself is the answer, as it is on the real network
            // stack. If the session follows it, it stops this load and ignores these.
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
        } else {
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data("{}".utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}

@Suite("The API client refuses every redirect", .serialized)
struct RedirectRefusalTests {
    private static func client(token: SessionToken?) -> KobolinkAPIClient {
        let configuration = KobolinkAPIClient.makeSessionConfiguration()
        configuration.protocolClasses = [RedirectingProtocol.self]
        let session = KobolinkAPIClient.makeSession(configuration: configuration)
        let base = URL(string: "https://pay.example.test")!
        return KobolinkAPIClient(
            configuration: APIConfiguration(baseURL: base),
            transport: URLSessionTransport(configuration: .init(session: session)),
            middlewares: [AuthMiddleware(baseURL: base, tokenStore: InMemoryTokenStore(token: token), relay: SessionRejectionRelay())]
        )
    }

    @Test("a 302 is the answer: nothing is sent to the Location, and the call reports an unexpected reply")
    func redirectNotFollowed() async {
        RedirectingProtocol.reset()
        let client = Self.client(token: nil)
        do throws(APIError) {
            _ = try await client.initializeCheckout(CK.request(), idempotencyKey: IdempotencyKey.make())
            Issue.record("a redirect answered the call")
        } catch {
            #expect(error == .unexpectedResponse(status: 302))
        }
        #expect(RedirectingProtocol.requests.compactMap { $0.url?.host } == ["pay.example.test"])
    }

    @Test("a merchant's bearer token cannot follow a redirect to another host")
    func tokenDoesNotFollow() async {
        RedirectingProtocol.reset()
        let client = Self.client(token: Fixture.tokenA)
        _ = try? await client.currentUser()
        let hosts = RedirectingProtocol.requests.compactMap { $0.url?.host }
        #expect(hosts == ["pay.example.test"])
        #expect(RedirectingProtocol.requests.first?.value(forHTTPHeaderField: "Authorization") != nil)
    }

    @Test("a login password cannot follow a redirect either")
    func passwordDoesNotFollow() async {
        RedirectingProtocol.reset()
        _ = try? await Self.client(token: nil).login(email: Fixture.email, password: Fixture.password)
        #expect(RedirectingProtocol.requests.compactMap { $0.url?.host } == ["pay.example.test"])
    }

    @Test("the app's own session is built with the refusing delegate")
    func appSessionHasDelegate() {
        let session = KobolinkAPIClient.makeSession()
        #expect(session.delegate is RedirectRefusingDelegate)
        #expect(session.configuration.waitsForConnectivity == false)
    }
}
