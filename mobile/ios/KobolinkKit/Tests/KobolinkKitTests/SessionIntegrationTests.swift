import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import KobolinkKit

/// Answers each request with the next reply in a script; the last one repeats.
private final class ScriptedTransport: ClientTransport, @unchecked Sendable {
    struct Reply { let status: Int; let body: String }

    private let lock = NSLock()
    private var replies: [Reply]
    private(set) var operations: [String] = []

    init(_ replies: [Reply]) { self.replies = replies }

    private func next(_ operationID: String) -> Reply {
        lock.lock()
        defer { lock.unlock() }
        operations.append(operationID)
        return replies.count > 1 ? replies.removeFirst() : replies[0]
    }

    func send(
        _ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String
    ) async throws -> (HTTPResponse, HTTPBody?) {
        let reply = next(operationID)
        var response = HTTPResponse(status: .init(code: reply.status))
        response.headerFields[.contentType] = "application/json"
        return (response, HTTPBody(reply.body))
    }
}

private let userJSON = """
    {"id":"usr_test01","role":"merchant","email":"merchant@example.test","phone":null,\
    "displayName":"Test Merchant","createdAt":"2026-01-02T03:04:05.000Z"}
    """
private let meOK = ScriptedTransport.Reply(status: 200, body: "{\"user\":\(userJSON)}")
private let unauthenticated = ScriptedTransport.Reply(
    status: 401, body: "{\"code\":\"unauthenticated\",\"message\":\"Sign in to continue.\"}")

/// The real client and middleware wired to the real controller, as `KobolinkApp` does.
@MainActor
private struct Stack {
    let store: InMemoryTokenStore
    let session: SessionController
    let transport: ScriptedTransport
    let client: KobolinkAPIClient

    init(token: SessionToken?, replies: [ScriptedTransport.Reply]) {
        store = InMemoryTokenStore(token: token)
        transport = ScriptedTransport(replies)
        let relay = SessionRejectionRelay()
        let baseURL = URL(string: "https://pay.example.test")!
        client = KobolinkAPIClient(
            configuration: APIConfiguration(baseURL: baseURL),
            transport: transport,
            middlewares: [AuthMiddleware(baseURL: baseURL, tokenStore: store, relay: relay)]
        )
        let controller = SessionController(
            auth: client, store: store, installMarker: InMemoryInstallMarker(isSet: true))
        relay.handler = { token in Task { @MainActor in controller.tokenRejected(token) } }
        session = controller
    }
}

@MainActor
@Suite("Session wiring: client, middleware and controller together")
struct SessionIntegrationTests {
    @Test("a stored token resolves to signed in through the real client")
    func coldStart() async {
        let stack = Stack(token: Fixture.tokenA, replies: [meOK])
        await stack.session.resolve()
        #expect(stack.session.state == .signedIn(Fixture.user))
        #expect(stack.transport.operations == ["getMe"])
    }

    @Test("a 401 on the cold-start check ends the session as expired, whichever of the two paths reports it first")
    func expiredOnColdStart() async throws {
        let stack = Stack(token: Fixture.tokenA, replies: [unauthenticated])
        await stack.session.resolve()
        #expect(stack.session.state == .signedOut(.sessionExpired))
        // Let the middleware's report (a hop to the main actor) land too; it must change nothing.
        try await Task.sleep(for: .milliseconds(50))
        #expect(stack.session.state == .signedOut(.sessionExpired))
        #expect(try stack.store.readToken() == nil)
    }

    @Test("a 401 to a later authenticated request signs the app out as expired")
    func expiredMidSession() async throws {
        let stack = Stack(token: Fixture.tokenA, replies: [meOK, unauthenticated])
        await stack.session.resolve()
        #expect(stack.session.state == .signedIn(Fixture.user))

        // Any authenticated call that comes back 401 reaches the controller through the relay.
        _ = try? await stack.client.currentUser()
        #expect(await waitUntil { stack.session.state == .signedOut(.sessionExpired) })
        #expect(try stack.store.readToken() == nil)
    }
}
