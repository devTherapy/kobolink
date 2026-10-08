import Foundation
import Security
import Testing

import KobolinkKit

// Invented values, for these tests only.
private let codeA = LinkCode("aBcDeFgH")!
private let codeB = LinkCode("kLmNpQrS")!
private let keyOne = "11111111-1111-4111-8111-000000000001"
private let keyTwo = "11111111-1111-4111-8111-000000000002"

private func pending(
    _ code: LinkCode = codeA, key: String = keyOne, owner: AttemptOwner = .payer, reference: String? = nil
) -> PendingCheckout {
    PendingCheckout(
        key: key,
        request: InitializeRequest(code: code, amountKobo: 1_850_050, payerName: "Ngozi Okafor", payerEmail: "ngozi@example.test"),
        reference: reference, confirmedAmountKobo: reference == nil ? nil : 1_850_050, owner: owner,
        merchantName: "Adebayo Stores", title: "Ankara Two-Piece Set", createdAt: Date(timeIntervalSince1970: 1_790_000_000))
}

/// The real Keychain, inside the app's own process (a package test bundle has no host, and the Keychain refuses
/// it with errSecMissingEntitlement). Each test uses a service name of its own and removes what it wrote.
@Suite("Keychain pending checkout store", .serialized)
struct KeychainPendingCheckoutStoreTests {
    private func makeStore() -> (KeychainPendingCheckoutStore, String) {
        let service = "test.kobolink.pending.\(UUID().uuidString)"
        return (KeychainPendingCheckoutStore(service: service), service)
    }

    private func cleanUp(_ store: KeychainPendingCheckoutStore) {
        for slot in (try? store.all()) ?? [] {
            switch slot {
            case .pending(let item): try? store.remove(item.request.code)
            case .unreadable(let id): try? store.remove(slotID: id)
            }
        }
    }

    /// The item's attributes straight from the Security framework, independent of the wrapper.
    private func attributes(service: String, account: String) -> [String: Any]? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecAttrSynchronizable: kSecAttrSynchronizableAny,
            kSecReturnAttributes: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? [String: Any]
    }

    @Test("an empty slot reads as nil, and removing nothing is not an error")
    func empty() throws {
        let (store, _) = makeStore()
        #expect(try store.load(codeA) == nil)
        try store.remove(codeA)
        #expect(try store.all().isEmpty)
    }

    @Test("save, load, replace and remove; one slot per link code")
    func roundTrip() throws {
        let (store, _) = makeStore()
        defer { cleanUp(store) }
        try store.save(pending(codeA))
        try store.save(pending(codeB, key: keyTwo))
        #expect(try store.load(codeA) == pending(codeA))
        try store.save(pending(codeA, reference: "kbl_aBcDeFgHjK"))
        #expect(try store.load(codeA)?.reference == "kbl_aBcDeFgHjK")
        #expect(try store.all().count == 2)
        try store.remove(codeA)
        #expect(try store.load(codeA) == nil)
        #expect(try store.load(codeB)?.key == keyTwo)
    }

    @Test("the attempt survives a relaunch: a new store over the same service reads it")
    func survivesRelaunch() throws {
        let (store, service) = makeStore()
        defer { cleanUp(store) }
        try store.save(pending(owner: .session(userID: "usr_one")))
        let again = KeychainPendingCheckoutStore(service: service)
        #expect(try again.load(codeA) == pending(owner: .session(userID: "usr_one")))
    }

    @Test("the item is a generic password, after-first-unlock, this-device-only, not synchronizable, one account per link code")
    func attributesAreAsPromised() throws {
        let (store, service) = makeStore()
        defer { cleanUp(store) }
        try store.save(pending())
        let item = try #require(attributes(service: service, account: codeA.value))
        #expect(item[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        let synchronizable = item[kSecAttrSynchronizable as String]
        #expect((synchronizable as? Bool ?? (synchronizable as? Int).map { $0 != 0 }) != true)
    }

    @Test("a second save, and an update of the reference, keep the accessibility class")
    func overwriteKeepsAccessibility() throws {
        let (store, service) = makeStore()
        defer { cleanUp(store) }
        try store.save(pending())
        try store.save(pending(reference: "kbl_aBcDeFgHjK"))
        let item = try #require(attributes(service: service, account: codeA.value))
        #expect(item[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    }

    @Test("stores with different service names do not see each other")
    func isolation() throws {
        let (first, _) = makeStore()
        let (second, _) = makeStore()
        defer { cleanUp(first); cleanUp(second) }
        try first.save(pending())
        #expect(try second.load(codeA) == nil)
        #expect(try second.all().isEmpty)
    }

    @Test("a slot that is not a pending checkout is refused on read, listed as unreadable, and can be removed")
    func unreadable() throws {
        let (store, service) = makeStore()
        defer { cleanUp(store) }
        let item: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: codeA.value,
            kSecValueData: Data("not a checkout".utf8),
        ]
        #expect(SecItemAdd(item as CFDictionary, nil) == errSecSuccess)
        do {
            _ = try store.load(codeA)
            Issue.record("an unreadable slot was read as nothing")
        } catch {
            #expect(error.kind == .undecodable)
        }
        #expect(try store.all() == [.unreadable(slotID: codeA.value)])
        try store.remove(slotID: codeA.value)
        #expect(try store.load(codeA) == nil)
    }

    @Test("a slot holding another link's record is not trusted for this code")
    func wrongCode() throws {
        let (store, service) = makeStore()
        defer { cleanUp(store) }
        let data = try JSONEncoder().encode(pending(codeB))
        let item: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: codeA.value, kSecValueData: data,
        ]
        #expect(SecItemAdd(item as CFDictionary, nil) == errSecSuccess)
        #expect(throws: PendingStoreError.self) { try store.load(codeA) }
    }

    @Test("saving a pending checkout puts nothing in UserDefaults and no file in the app's containers")
    func notInUserDefaultsOrFiles() throws {
        let (store, _) = makeStore()
        defer { cleanUp(store) }
        try store.save(pending())
        let standard = String(describing: UserDefaults.standard.dictionaryRepresentation())
        #expect(!standard.contains("Ngozi") && !standard.contains(keyOne) && !standard.contains("ngozi@example.test"))
        // Excluded from backup by construction: there is no file to include. Nothing under the app's
        // Documents, Library or tmp mentions the payer.
        let fileManager = FileManager.default
        let roots = [
            fileManager.urls(for: .documentDirectory, in: .userDomainMask).first,
            fileManager.urls(for: .libraryDirectory, in: .userDomainMask).first,
            URL(fileURLWithPath: NSTemporaryDirectory()),
        ].compactMap { $0 }
        for root in roots {
            let enumerator = fileManager.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey])
            while let url = enumerator?.nextObject() as? URL {
                guard let data = try? Data(contentsOf: url), data.count < 5_000_000 else { continue }
                let text = String(decoding: data, as: UTF8.self)
                #expect(!text.contains("ngozi@example.test") && !text.contains(keyOne), "\(url.path)")
            }
        }
    }
}
