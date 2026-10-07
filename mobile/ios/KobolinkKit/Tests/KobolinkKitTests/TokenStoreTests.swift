import Foundation
import Testing

@testable import KobolinkKit

@Suite("Session token")
struct SessionTokenTests {
    @Test("a token can be created from header-safe characters")
    func valid() {
        #expect(SessionToken("abc_DEF-123.~+/=")?.reveal() == "abc_DEF-123.~+/=")
    }

    @Test("a token that could break out of a header value is refused", arguments: [
        "", "has space", "line\nbreak", "tab\there", "carriage\rreturn", "nul\0byte", "caf\u{E9}", "\u{7F}",
    ])
    func invalid(raw: String) {
        #expect(SessionToken(raw) == nil)
    }

    @Test("every way of printing a token shows <redacted>")
    func redacted() {
        let token = Fixture.tokenA
        let secret = token.reveal()
        var dumped = ""
        dump(token, to: &dumped)
        let texts = [
            "\(token)", String(describing: token), String(reflecting: token), "\(Optional(token) as Any)",
            "\([token])", dumped, String(describing: [token: 1]),
        ]
        for text in texts {
            #expect(!text.contains(secret), "leaked in: \(text)")
        }
        #expect("\(token)" == "<redacted>")
    }

    @Test("a store error names the operation and status and nothing else")
    func errorHasNoToken() {
        let error = TokenStoreError(operation: .save, status: -25299)
        #expect(!String(describing: error).contains(Fixture.tokenA.reveal()))
        #expect(String(describing: error).contains("-25299"))
    }
}

@Suite("In-memory token store")
struct InMemoryTokenStoreTests {
    @Test("save, read, overwrite, clear")
    func roundTrip() throws {
        let store = InMemoryTokenStore()
        #expect(try store.readToken() == nil)
        try store.saveToken(Fixture.tokenA)
        #expect(try store.readToken() == Fixture.tokenA)
        try store.saveToken(Fixture.tokenB)
        #expect(try store.readToken() == Fixture.tokenB)
        try store.clearToken()
        #expect(try store.readToken() == nil)
    }

    @Test("a switched-on failure throws until healed, and leaves the token alone")
    func failures() throws {
        let store = InMemoryTokenStore(token: Fixture.tokenA)
        store.fail(.clear)
        #expect(throws: TokenStoreError.self) { try store.clearToken() }
        store.heal()
        #expect(try store.readToken() == Fixture.tokenA)
    }
}

@Suite("Install marker")
struct InstallMarkerTests {
    @Test("a fresh suite is a fresh install; once set it stays set across instances")
    func marker() {
        let suite = "test.kobolink.marker.\(UUID().uuidString)"
        defer { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        #expect(!UserDefaultsInstallMarker(suiteName: suite).isSet)
        UserDefaultsInstallMarker(suiteName: suite).set()
        #expect(UserDefaultsInstallMarker(suiteName: suite).isSet)
    }

    @Test("the marker holds a boolean, and no value in its suite is ever a session token")
    func markerHoldsNoToken() throws {
        let suite = "test.kobolink.marker.\(UUID().uuidString)"
        defer { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        let marker = UserDefaultsInstallMarker(suiteName: suite)
        marker.set()
        let store = InMemoryTokenStore()
        try store.saveToken(Fixture.tokenA)
        let stored = try #require(UserDefaults(suiteName: suite)?.dictionaryRepresentation())
        for (key, value) in stored where key == UserDefaultsInstallMarker.key {
            #expect(value as? Bool == true)
        }
        #expect(!String(describing: stored).contains(Fixture.tokenA.reveal()))
    }
}
