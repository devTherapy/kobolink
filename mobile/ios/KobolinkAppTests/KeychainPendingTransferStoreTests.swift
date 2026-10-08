import Foundation
import Security
import Testing

import KobolinkKit

// Invented values, for these tests only.
private let userOne = "usr_one"
private let userTwo = "usr_two"
private let keyOne = "11111111-1111-4111-8111-000000000001"
private let keyTwo = "11111111-1111-4111-8111-000000000002"

private func attempt(user: String = userOne, key: String = keyOne, note: String? = nil, payee: String? = nil) -> TransferAttempt {
    TransferAttempt(
        key: key, userID: user,
        instruction: TransferInstruction(toPhone: "+2348031234567", amountKobo: 150_050, note: note),
        payeeName: payee, createdAt: Date(timeIntervalSince1970: 1_790_000_000))
}

/// The real Keychain, inside the app's own process (a package test bundle has no host, and the Keychain refuses it
/// with errSecMissingEntitlement). Each test uses a service name of its own and removes what it wrote.
@Suite("Keychain pending transfer store", .serialized)
struct KeychainPendingTransferStoreTests {
    private func makeStore() -> (KeychainPendingTransferStore, String) {
        let service = "test.kobolink.transfer.\(UUID().uuidString)"
        return (KeychainPendingTransferStore(service: service), service)
    }

    private func cleanUp(_ store: KeychainPendingTransferStore) {
        for slot in (try? store.all()) ?? [] {
            switch slot {
            case .pending(let item): try? store.remove(userID: item.userID)
            case .unreadable(let id): try? store.remove(slotID: id)
            }
        }
        try? store.clearObligation()
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
        #expect(try store.load(userID: userOne) == nil)
        try store.remove(userID: userOne)
        #expect(try store.all().isEmpty)
    }

    @Test("save, load, replace and remove; one slot per user")
    func roundTrip() throws {
        let (store, _) = makeStore()
        defer { cleanUp(store) }
        try store.save(attempt(user: userOne))
        try store.save(attempt(user: userTwo, key: keyTwo))
        #expect(try store.load(userID: userOne) == attempt(user: userOne))
        try store.save(attempt(user: userOne, key: keyTwo, note: "Rent", payee: "Ada Obi"))
        #expect(try store.load(userID: userOne)?.key == keyTwo)
        #expect(try store.load(userID: userOne)?.instruction.note == "Rent")
        #expect(try store.load(userID: userOne)?.payeeName == "Ada Obi")
        #expect(try store.all().count == 2)
        try store.remove(userID: userOne)
        #expect(try store.load(userID: userOne) == nil)
        #expect(try store.load(userID: userTwo)?.key == keyTwo)
    }

    @Test("the attempt survives a relaunch: a new store over the same service reads it, request and key byte for byte")
    func survivesRelaunch() throws {
        let (store, service) = makeStore()
        defer { cleanUp(store) }
        let saved = attempt(note: "Rent for October", payee: "Ada Obi")
        try store.save(saved)
        let again = KeychainPendingTransferStore(service: service)
        #expect(try again.load(userID: userOne) == saved)
        #expect(try again.load(userID: userOne)?.instruction == saved.instruction)
    }

    @Test("a user's slot is that user's: another user's lookup finds nothing")
    func scopedToTheUser() throws {
        let (store, _) = makeStore()
        defer { cleanUp(store) }
        try store.save(attempt(user: userOne))
        #expect(try store.load(userID: userTwo) == nil)
    }

    @Test("the item is a generic password, after-first-unlock, this-device-only, not synchronizable, one account per user")
    func attributesAreAsPromised() throws {
        let (store, service) = makeStore()
        defer { cleanUp(store) }
        try store.save(attempt())
        let item = try #require(attributes(service: service, account: userOne))
        #expect(item[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        let synchronizable = item[kSecAttrSynchronizable as String]
        #expect((synchronizable as? Bool ?? (synchronizable as? Int).map { $0 != 0 }) != true)
    }

    @Test("the same attributes as the checkout's store: service family, class, accessibility, synchronizable")
    func sameAttributesAsTheCheckoutStore() throws {
        let transfers = "test.kobolink.transfer.\(UUID().uuidString)"
        let checkouts = "test.kobolink.pending.\(UUID().uuidString)"
        let transferStore = KeychainPendingTransferStore(service: transfers)
        let checkoutStore = KeychainPendingCheckoutStore(service: checkouts)
        let code = try #require(LinkCode("aBcDeFgH"))
        defer {
            cleanUp(transferStore)
            try? checkoutStore.remove(code)
        }
        try transferStore.save(attempt())
        try checkoutStore.save(
            PendingCheckout(
                key: keyOne, request: InitializeRequest(code: code, amountKobo: 1_850_000, payerName: "Ngozi Okafor", payerEmail: "n@example.test"),
                owner: .payer, merchantName: "Adebayo Stores", title: "Ankara", createdAt: Date(timeIntervalSince1970: 1_790_000_000)))
        let a = try #require(attributes(service: transfers, account: userOne))
        let b = try #require(attributes(service: checkouts, account: code.value))
        for name in [kSecClass, kSecAttrAccessible] as [CFString] {
            #expect(String(describing: a[name as String]) == String(describing: b[name as String]), "\(name)")
        }
        let syncA = a[kSecAttrSynchronizable as String]
        let syncB = b[kSecAttrSynchronizable as String]
        #expect(String(describing: syncA) == String(describing: syncB))
        #expect(KeychainPendingTransferStore.defaultService != KeychainPendingCheckoutStore.defaultService)
    }

    @Test("a second save keeps the accessibility class")
    func overwriteKeepsAccessibility() throws {
        let (store, service) = makeStore()
        defer { cleanUp(store) }
        try store.save(attempt())
        try store.save(attempt(key: keyTwo))
        let item = try #require(attributes(service: service, account: userOne))
        #expect(item[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    }

    @Test("stores with different service names do not see each other")
    func isolation() throws {
        let (first, _) = makeStore()
        let (second, _) = makeStore()
        defer { cleanUp(first); cleanUp(second) }
        try first.save(attempt())
        #expect(try second.load(userID: userOne) == nil)
        #expect(try second.all().isEmpty)
    }

    @Test("a slot that is not a pending transfer is refused on read, listed as unreadable, and can be removed")
    func unreadable() throws {
        let (store, service) = makeStore()
        defer { cleanUp(store) }
        let item: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: userOne,
            kSecValueData: Data("not a transfer".utf8),
        ]
        #expect(SecItemAdd(item as CFDictionary, nil) == errSecSuccess)
        do {
            _ = try store.load(userID: userOne)
            Issue.record("an unreadable slot was read as nothing")
        } catch {
            #expect(error.kind == .undecodable)
        }
        #expect(try store.all() == [.unreadable(slotID: userOne)])
        try store.remove(slotID: userOne)
        #expect(try store.load(userID: userOne) == nil)
    }

    @Test("a slot holding another user's record is not trusted for this account")
    func wrongUser() throws {
        let (store, service) = makeStore()
        defer { cleanUp(store) }
        let data = try JSONEncoder().encode(attempt(user: userTwo))
        let item: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: userOne, kSecValueData: data,
        ]
        #expect(SecItemAdd(item as CFDictionary, nil) == errSecSuccess)
        #expect(throws: PendingStoreError.self) { try store.load(userID: userOne) }
        #expect(try store.all() == [.unreadable(slotID: userOne)])
    }

    @Test("the owed cleanup is stored, survives a relaunch, is replaced, taken back, and never listed as a slot")
    func obligation() throws {
        let (store, service) = makeStore()
        defer { cleanUp(store) }
        #expect(try store.loadObligation() == nil)
        try store.clearObligation()
        let owed = SignOutObligation(entries: [.init(code: userOne, key: keyOne), .init(code: userTwo, key: nil)])
        try store.saveObligation(owed)
        try store.save(attempt())
        #expect(try KeychainPendingTransferStore(service: service).loadObligation() == owed)
        #expect(try store.all().count == 1)
        let narrower = SignOutObligation(entries: [.init(code: userOne, key: keyTwo)])
        try store.saveObligation(narrower)
        #expect(try store.loadObligation() == narrower)
        let item = try #require(attributes(service: service + ".obligation", account: "cleanup"))
        #expect(item[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        try store.clearObligation()
        #expect(try store.loadObligation() == nil)
    }

    @Test("an obligation that cannot be read is an error, never 'nothing owed'")
    func unreadableObligation() throws {
        let (store, service) = makeStore()
        defer { cleanUp(store) }
        let item: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword, kSecAttrService: service + ".obligation", kSecAttrAccount: "cleanup",
            kSecValueData: Data("future".utf8),
        ]
        #expect(SecItemAdd(item as CFDictionary, nil) == errSecSuccess)
        do {
            _ = try store.loadObligation()
            Issue.record("an unreadable obligation was read as nothing")
        } catch {
            #expect(error.kind == .undecodable)
        }
    }

    @Test("a note-less attempt is stored without a note key at all, and a pending transfer puts nothing in UserDefaults or files")
    func notInUserDefaultsOrFiles() throws {
        let (store, service) = makeStore()
        defer { cleanUp(store) }
        try store.save(attempt())
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: userOne,
            kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        #expect(SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess)
        let text = String(decoding: (result as? Data) ?? Data(), as: UTF8.self)
        #expect(!text.contains("note") && !text.contains("null"), "\(text)")

        let standard = String(describing: UserDefaults.standard.dictionaryRepresentation())
        #expect(!standard.contains("+2348031234567") && !standard.contains(keyOne))
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
                let contents = String(decoding: data, as: UTF8.self)
                #expect(!contents.contains("+2348031234567") && !contents.contains(keyOne), "\(url.path)")
            }
        }
    }
}
