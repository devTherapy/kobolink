import Foundation
import Security
import Testing

import KobolinkKit

// Invented values, for these tests only.
private let codeA = LinkCode("aBcDeFgH")!
private let codeB = LinkCode("kLmNpQrS")!
private let keyOne = "11111111-1111-4111-8111-000000000001"
private let keyTwo = "11111111-1111-4111-8111-000000000002"

private func pending(_ code: LinkCode, key: String, owner: AttemptOwner) -> PendingCheckout {
    PendingCheckout(
        key: key,
        request: InitializeRequest(code: code, amountKobo: 1_850_000, payerName: "Ngozi Okafor", payerEmail: "ngozi@example.test"),
        owner: owner, merchantName: "Adebayo Stores", title: "Ankara Two-Piece Set", createdAt: Date(timeIntervalSince1970: 1_790_000_000))
}

/// A service that answers from memory and records every key it was sent.
private final class ScriptedService: CheckoutServing, @unchecked Sendable {
    private let lock = NSLock()
    private var keys: [String] = []

    var sentKeys: [String] {
        lock.lock()
        defer { lock.unlock() }
        return keys
    }

    func lookupLink(code: LinkCode) async throws(APIError) -> LinkLookup {
        LinkLookup(
            link: CheckoutLink(code: code, merchantName: "Adebayo Stores", title: "Ankara Two-Piece Set", amountKobo: 1_850_000),
            availability: .payable)
    }

    private func record(_ key: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        keys.append(key)
        return keys.count == 1
    }

    func initializeCheckout(_ request: InitializeRequest, idempotencyKey: String) async throws(APIError) -> StartedCheckout {
        if record(idempotencyKey) { throw .unreachable(.networkConnectionLost) }
        return StartedCheckout(reference: "kbl_aBcDeFgHjK", code: request.code, amountKobo: request.amountKobo, createdAt: Date())
    }
}

/// The checkout controller over the real Keychain, inside the app's own process.
@MainActor
@Suite("Checkout over the real Keychain", .serialized)
struct CheckoutKeychainIntegrationTests {
    private func waitUntil(_ condition: @MainActor () -> Bool) async -> Bool {
        for _ in 0..<400 {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return condition()
    }

    private func controller(service: String, backend: ScriptedService) -> CheckoutController {
        CheckoutController(service: backend, store: KeychainPendingCheckoutStore(service: service), ownerNow: { .payer })
    }

    private func attempt(_ controller: CheckoutController) -> AttemptScreen? {
        if case .attempt(let screen) = controller.screen { screen } else { nil }
    }

    private func clean(_ store: KeychainPendingCheckoutStore) {
        for case .pending(let item) in (try? store.all()) ?? [] { try? store.remove(item.request.code) }
    }

    @Test("a dropped payment is found again by a new process, before any session, and retried under the SAME key")
    func coldStartRetriesSameKey() async throws {
        let service = "test.kobolink.pending.\(UUID().uuidString)"
        let store = KeychainPendingCheckoutStore(service: service)
        defer { clean(store) }

        // Process one: the payer fills the form, taps Pay, and the connection drops.
        let backend = ScriptedService()
        let first = controller(service: service, backend: backend)
        first.open(codeA)
        #expect(await waitUntil { if case .link = first.screen { true } else { false } })
        first.form.name = "Ngozi Okafor"
        first.form.email = "ngozi@example.test"
        first.pay()
        #expect(await waitUntil { attempt(first)?.phase == .unsettled(.noConnection) })
        let key = try #require(backend.sentKeys.first)
        #expect(try store.load(codeA)?.key == key)

        // Process two, with nothing in memory: the link opens on the interrupted attempt, with no network call.
        let second = controller(service: service, backend: backend)
        second.open(codeA)
        #expect(attempt(second)?.phase == .unsettled(.interrupted))
        second.retry()
        #expect(await waitUntil { attempt(second)?.phase == .started })
        #expect(backend.sentKeys == [key, key])

        // Process three: the started payment comes back with its reference.
        let third = controller(service: service, backend: backend)
        third.open(codeA)
        #expect(attempt(third)?.phase == .started)
        #expect(attempt(third)?.reference == "kbl_aBcDeFgHjK")
    }

    @Test("signing out removes a signed-in merchant's attempt from the Keychain and leaves a payer's")
    func signOutClearsKeychain() throws {
        let service = "test.kobolink.pending.\(UUID().uuidString)"
        let store = KeychainPendingCheckoutStore(service: service)
        defer { clean(store) }
        try store.save(pending(codeA, key: keyOne, owner: .session(userID: nil)))
        try store.save(pending(codeB, key: keyTwo, owner: .payer))

        controller(service: service, backend: ScriptedService()).sessionDidChange(.signedOutByChoice)
        #expect(try store.load(codeA) == nil)
        #expect(try store.load(codeB)?.key == keyTwo)
    }

    @Test("an unreadable slot is removed by sign-out, and a cold start on it is blocked, not read as nothing")
    func unreadableSlot() throws {
        let service = "test.kobolink.pending.\(UUID().uuidString)"
        let store = KeychainPendingCheckoutStore(service: service)
        defer { clean(store) }
        // Something this build cannot read, saved by a different version.
        let item: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: codeA.value,
            kSecValueData: Data("future format".utf8),
        ]
        #expect(SecItemAdd(item as CFDictionary, nil) == errSecSuccess)

        let checkout = controller(service: service, backend: ScriptedService())
        checkout.open(codeA)
        #expect(checkout.screen == .storageBlocked(codeA, .undecodable))
        checkout.sessionDidChange(.signedOutByChoice)
        #expect(try store.all().isEmpty)
    }
}
