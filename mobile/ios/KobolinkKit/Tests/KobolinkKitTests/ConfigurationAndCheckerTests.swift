import Foundation
import Testing

@testable import KobolinkKit

@Suite("API configuration")
struct APIConfigurationTests {
    private func read(
        _ value: Any?,
        policy: APIConfiguration.Policy = .debug
    ) throws(APIConfiguration.Problem) -> APIConfiguration {
        try APIConfiguration(
            infoDictionary: value.map { [APIConfiguration.infoPlistKey: $0] } ?? [:],
            policy: policy
        )
    }

    @Test("the test build is a debug build, so the debug policy is the one in force")
    func debugFlagReachesThePackage() {
        #expect(APIConfiguration.Policy.current == .debug)
    }

    @Test("debug accepts a local http URL with a port")
    func localURL() throws {
        let configuration = try read("http://localhost:3001")
        #expect(configuration.baseURL.absoluteString == "http://localhost:3001")
        #expect(configuration.host == "localhost")
    }

    @Test("an https host is accepted under either policy", arguments: [APIConfiguration.Policy.debug, .release])
    func httpsURL(policy: APIConfiguration.Policy) throws {
        #expect(try read("https://pay.folusayo.com", policy: policy).host == "pay.folusayo.com")
        #expect(try read("https://pay.folusayo.com/", policy: policy).host == "pay.folusayo.com")
    }

    @Test("release refuses cleartext http", arguments: [
        "http://localhost:3001", "http://pay.folusayo.com", "HTTP://pay.folusayo.com",
    ])
    func releaseRejectsHTTP(value: String) {
        #expect(throws: APIConfiguration.Problem.insecure(value)) { try read(value, policy: .release) }
    }

    @Test("a base URL with a path is refused, because the operations already start with /api",
          arguments: [APIConfiguration.Policy.debug, .release])
    func rejectsPath(policy: APIConfiguration.Policy) {
        for value in ["https://pay.folusayo.com/api", "https://pay.folusayo.com/v1/"] {
            #expect(throws: APIConfiguration.Problem.hasPath(value)) { try read(value, policy: policy) }
        }
    }

    @Test("a query or fragment is refused too", arguments: [
        "https://pay.folusayo.com?x=1", "https://pay.folusayo.com#top",
    ])
    func rejectsQueryAndFragment(value: String) {
        #expect(throws: APIConfiguration.Problem.hasPath(value)) { try read(value, policy: .release) }
    }

    @Test("a missing key is reported as missing")
    func missing() {
        #expect(throws: APIConfiguration.Problem.missing) { try read(nil) }
        #expect(throws: APIConfiguration.Problem.missing) { try APIConfiguration(infoDictionary: nil) }
    }

    @Test("an unexpanded build setting is reported as unresolved, not as a URL")
    func unresolved() {
        #expect(throws: APIConfiguration.Problem.unresolved("$(KOBOLINK_API_BASE_URL)")) {
            try read("$(KOBOLINK_API_BASE_URL)")
        }
        #expect(throws: APIConfiguration.Problem.unresolved("")) { try read("  ") }
    }

    @Test("anything that is not an absolute http(s) URL with a host is invalid", arguments: [
        "ftp://pay.example.test", "pay.example.test", "http://", "/api", "kobolink://l/abc",
    ])
    func invalid(value: String) {
        #expect(throws: APIConfiguration.Problem.invalid(value)) { try read(value) }
    }
}

@MainActor
@Suite("Connection checker")
struct ConnectionCheckerTests {
    struct StubHealth: HealthChecking {
        let result: APIError?
        func health() async throws(APIError) {
            if let result { throw result }
        }
    }

    actor FlippingHealth: HealthChecking {
        private var cancelled = false
        func cancelNext() { cancelled = true }
        func health() async throws(APIError) {
            if cancelled { cancelled = false; throw APIError.cancelled }
        }
    }

    /// Holds every call open until released, and counts how many arrived.
    actor GatedHealth: HealthChecking {
        private(set) var calls = 0
        private var waiting: CheckedContinuation<Void, Never>?
        private var open = false

        func health() async throws(APIError) {
            calls += 1
            if open { return }
            await withCheckedContinuation { waiting = $0 }
        }

        func release() {
            waiting?.resume()
            waiting = nil
        }

        func releaseAutomatically() { open = true }
    }

    @Test("starts out checking")
    func initial() {
        #expect(ConnectionChecker(api: StubHealth(result: nil)).status == .checking)
    }

    @Test("a healthy API is reachable")
    func reachable() async {
        let checker = ConnectionChecker(api: StubHealth(result: nil))
        await checker.check()
        #expect(checker.status == .reachable)
    }

    @Test("a refusal shows the server's own message")
    func serverMessage() async {
        let error = APIError.server(.init(status: 503, code: ._internal, message: "Database is down."))
        let checker = ConnectionChecker(api: StubHealth(result: error))
        await checker.check()
        #expect(checker.status == .failed("Database is down."))
    }

    @Test("no connection shows a plain sentence, not an error code")
    func unreachable() async {
        let checker = ConnectionChecker(api: StubHealth(result: .unreachable(.notConnectedToInternet)))
        await checker.check()
        #expect(checker.status == .failed("Can't reach the server. Check your connection and try again."))
    }

    @Test("a cancelled first check settles, so the screen is not left spinning")
    func cancelledFirstCheck() async {
        let checker = ConnectionChecker(api: StubHealth(result: .cancelled))
        await checker.check()
        #expect(checker.status != .checking)
        #expect(checker.status == .failed(ConnectionChecker.interruptedMessage))
    }

    @Test("a cancelled re-check restores the answer it interrupted")
    func cancelledRecheck() async {
        let flipping = FlippingHealth()
        let checker = ConnectionChecker(api: flipping)
        await checker.check()
        #expect(checker.status == .reachable)
        await flipping.cancelNext()
        await checker.check()
        #expect(checker.status == .reachable)
    }

    @Test("overlapping checks share one request and one answer")
    func overlappingChecksCoalesce() async {
        let gate = GatedHealth()
        let checker = ConnectionChecker(api: gate)
        async let first: Void = checker.check()
        async let second: Void = checker.check()
        while await gate.calls == 0 { await Task.yield() }
        #expect(checker.status == .checking)
        await gate.release()
        _ = await (first, second)
        #expect(await gate.calls == 1)
        #expect(checker.status == .reachable)
    }

    @Test("a check after the previous one finished makes a new request")
    func sequentialChecksAreNotCoalesced() async {
        let gate = GatedHealth()
        let checker = ConnectionChecker(api: gate)
        async let first: Void = checker.check()
        while await gate.calls == 0 { await Task.yield() }
        await gate.release()
        await first
        await gate.releaseAutomatically()
        await checker.check()
        #expect(await gate.calls == 2)
    }

    @Test("checking again after a failure recovers")
    func recovers() async {
        actor Flaky: HealthChecking {
            private var calls = 0
            func health() async throws(APIError) {
                calls += 1
                if calls == 1 { throw APIError.unreachable(.timedOut) }
            }
        }
        let checker = ConnectionChecker(api: Flaky())
        await checker.check()
        guard case .failed = checker.status else {
            Issue.record("first check should fail")
            return
        }
        await checker.check()
        #expect(checker.status == .reachable)
    }
}
