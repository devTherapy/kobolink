import Foundation
import Security
import Testing

import KobolinkKit

// Invented values, for these tests only.
private let tokenA = SessionToken("tokA_" + String(repeating: "a1B2", count: 10))!
private let tokenB = SessionToken("tokB_" + String(repeating: "c3D4", count: 10))!

/// The real Keychain, tested inside the app's own process.
///
/// This lives in `KobolinkAppTests` (hosted by `Kobolink.app`), not in the package's test bundle: the
/// package tests run without a host app, and the Keychain refuses an unhosted process with
/// `errSecMissingEntitlement` (-34018). Each test uses a service name of its own and removes it
/// afterwards, so a real session on the same Simulator is never touched.
@Suite("Keychain token store", .serialized)
struct KeychainTokenStoreTests {
    private func makeStore() -> (KeychainTokenStore, String) {
        let service = "test.kobolink.session.\(UUID().uuidString)"
        return (KeychainTokenStore(service: service), service)
    }

    /// The item's attributes, read straight from the Security framework, independent of the wrapper.
    private func attributes(service: String) -> [String: Any]? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: KeychainTokenStore.account,
            kSecAttrSynchronizable: kSecAttrSynchronizableAny,
            kSecReturnAttributes: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? [String: Any]
    }

    @Test("a missing item reads as nil, and clearing nothing is not an error")
    func empty() throws {
        let (store, _) = makeStore()
        #expect(try store.readToken() == nil)
        try store.clearToken()
    }

    @Test("save then read returns the token; saving again replaces it; clear removes it")
    func roundTrip() throws {
        let (store, _) = makeStore()
        defer { try? store.clearToken() }
        try store.saveToken(tokenA)
        #expect(try store.readToken() == tokenA)
        try store.saveToken(tokenB)
        #expect(try store.readToken() == tokenB)
        try store.clearToken()
        #expect(try store.readToken() == nil)
    }

    @Test("the token survives a relaunch: a new store over the same service reads it")
    func survivesRelaunch() throws {
        let (store, service) = makeStore()
        defer { try? store.clearToken() }
        try store.saveToken(tokenA)
        #expect(try KeychainTokenStore(service: service).readToken() == tokenA)
    }

    @Test("the item is a generic password, after-first-unlock, this-device-only, and not synchronizable")
    func attributesAreAsPromised() throws {
        let (store, service) = makeStore()
        defer { try? store.clearToken() }
        try store.saveToken(tokenA)
        let item = try #require(attributes(service: service))
        // The query above asks for kSecClassGenericPassword, so finding the item proves its class.
        #expect(item[kSecAttrAccount as String] as? String == KeychainTokenStore.account)
        #expect(item[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        // Absent and false both mean "not synced"; only 1/true would be iCloud Keychain.
        let synchronizable = item[kSecAttrSynchronizable as String]
        #expect((synchronizable as? Bool ?? (synchronizable as? Int).map { $0 != 0 }) != true)
    }

    @Test("an overwrite keeps the accessibility class")
    func overwriteKeepsAccessibility() throws {
        let (store, service) = makeStore()
        defer { try? store.clearToken() }
        try store.saveToken(tokenA)
        try store.saveToken(tokenB)
        let item = try #require(attributes(service: service))
        #expect(item[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    }

    @Test("stores with different service names do not see each other")
    func isolation() throws {
        let (first, _) = makeStore()
        let (second, _) = makeStore()
        defer {
            try? first.clearToken()
            try? second.clearToken()
        }
        try first.saveToken(tokenA)
        #expect(try second.readToken() == nil)
    }

    @Test("something in the slot that is not a token reads as corrupt, not as no session")
    func corrupt() throws {
        let (store, service) = makeStore()
        defer { try? store.clearToken() }
        let item: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: KeychainTokenStore.account,
            kSecValueData: Data([0xFF, 0xFE, 0x00, 0x20]),
        ]
        #expect(SecItemAdd(item as CFDictionary, nil) == errSecSuccess)
        #expect(throws: TokenStoreError.self) { try store.readToken() }
        do {
            _ = try store.readToken()
        } catch {
            #expect(error.kind == .corrupt)
        }
    }

    @Test("saving a token puts it in no UserDefaults domain")
    func notInUserDefaults() throws {
        let (store, _) = makeStore()
        defer { try? store.clearToken() }
        try store.saveToken(tokenA)
        let secret = tokenA.reveal()
        let standard = UserDefaults.standard.dictionaryRepresentation()
        #expect(!String(describing: standard).contains(secret))
        let globalDomain = UserDefaults.standard.persistentDomain(forName: Bundle.main.bundleIdentifier ?? "") ?? [:]
        #expect(!String(describing: globalDomain).contains(secret))
    }
}
