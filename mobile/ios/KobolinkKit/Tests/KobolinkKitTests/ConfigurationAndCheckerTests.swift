import Foundation
import Testing

@testable import KobolinkKit

@Suite("API configuration")
struct APIConfigurationTests {
    private func read(_ value: Any?) throws(APIConfiguration.Problem) -> APIConfiguration {
        try APIConfiguration(infoDictionary: value.map { [APIConfiguration.infoPlistKey: $0] } ?? [:])
    }

    @Test("a local http URL with a port is accepted")
    func localURL() throws {
        let configuration = try read("http://localhost:3001")
        #expect(configuration.baseURL.absoluteString == "http://localhost:3001")
        #expect(configuration.host == "localhost")
    }

    @Test("an https host is accepted")
    func httpsURL() throws {
        #expect(try read("https://pay.folusayo.com").host == "pay.folusayo.com")
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

    @Test("a cancelled check does not report a failure")
    func cancelled() async {
        let checker = ConnectionChecker(api: StubHealth(result: .cancelled))
        await checker.check()
        #expect(checker.status == .checking)
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
