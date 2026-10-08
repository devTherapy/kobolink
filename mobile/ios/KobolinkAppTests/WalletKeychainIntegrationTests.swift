import Foundation
import Security
import Testing

import KobolinkKit

// Invented values, for these tests only.
private let userOne = SignedInUser(id: "usr_one", email: "one@example.test", displayName: "One", role: .customer)
private let userTwo = SignedInUser(id: "usr_two", email: "two@example.test", displayName: "Two", role: .customer)

/// A wallet service that answers from memory, records every request, and can see the Keychain at the instant the
/// transfer "leaves".
private final class ScriptedWallet: WalletServing, @unchecked Sendable {
    struct Sent: Equatable {
        let instruction: TransferInstruction
        let key: String
    }

    private let lock = NSLock()
    private var log: [Sent] = []
    private var heldWhenSent: [TransferAttempt?] = []
    private let store: KeychainPendingTransferStore
    private let dropFirst: Bool

    init(store: KeychainPendingTransferStore, dropFirst: Bool) {
        self.store = store
        self.dropFirst = dropFirst
    }

    var sent: [Sent] {
        lock.lock()
        defer { lock.unlock() }
        return log
    }

    /// What the Keychain held for the user at the moment each transfer left.
    var storedAtSend: [TransferAttempt?] {
        lock.lock()
        defer { lock.unlock() }
        return heldWhenSent
    }

    func wallet() async throws(APIError) -> WalletBalance {
        WalletBalance(accountId: "acc_one", balanceKobo: 5_000_000, asOf: Date())
    }

    func activity(cursor: String?) async throws(APIError) -> ActivityPage {
        ActivityPage(items: [], nextCursor: nil)
    }

    func transfer(_ instruction: TransferInstruction, idempotencyKey: String) async throws(APIError) -> TransferReceipt {
        let stored = try? store.load(userID: userOne.id)
        let first: Bool = {
            lock.lock()
            defer { lock.unlock() }
            log.append(Sent(instruction: instruction, key: idempotencyKey))
            heldWhenSent.append(stored)
            return log.count == 1
        }()
        if first && dropFirst { throw .unreachable(.networkConnectionLost) }
        return TransferReceipt(
            activity: WalletActivity(
                id: "pst_1", kind: .transfer, amountKobo: -instruction.amountKobo, counterparty: "Ada Obi", note: instruction.note,
                createdAt: Date()),
            wallet: WalletBalance(accountId: "acc_one", balanceKobo: 4_850_000, asOf: Date()))
    }
}

private struct NoCamera: CameraAccess {
    var hasCamera: Bool { false }
    var authorization: CameraAuthorization { .authorized }
    func requestAccess() async -> Bool { false }
}

/// The wallet over the real Keychain, inside the app's own process.
@MainActor
@Suite("Wallet over the real Keychain", .serialized)
struct WalletKeychainIntegrationTests {
    private func waitUntil(_ condition: @MainActor () -> Bool) async -> Bool {
        for _ in 0..<400 {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return condition()
    }

    private func clean(_ store: KeychainPendingTransferStore) {
        for slot in (try? store.all()) ?? [] {
            switch slot {
            case .pending(let item): try? store.remove(userID: item.userID)
            case .unreadable(let id): try? store.remove(slotID: id)
            }
        }
        try? store.clearObligation()
    }

    private func wallet(_ store: KeychainPendingTransferStore, _ backend: ScriptedWallet, user: SignedInUser = userOne) -> WalletController {
        let controller = WalletController(service: backend, store: store, camera: NoCamera())
        controller.sessionDidChange(.resolved(user))
        return controller
    }

    private func pay(_ wallet: WalletController, note: String = "") {
        wallet.openSend()
        wallet.send.form.setPhone("0803 123 4567")
        wallet.send.form.amountText = "1500.50"
        wallet.send.form.note = note
        wallet.send.review()
        wallet.send.confirm()
    }

    private func failedAttempt(_ wallet: WalletController) -> (TransferAttempt, TransferFailure)? {
        if case .failed(let attempt, let failure) = wallet.send.screen { (attempt, failure) } else { nil }
    }

    @Test("the attempt is in the Keychain when the request leaves, and a dropped payment is found again by a new process and retried under the SAME key")
    func writtenBeforeSendAndRetriedWithTheSameKey() async throws {
        let service = "test.kobolink.transfer.\(UUID().uuidString)"
        let store = KeychainPendingTransferStore(service: service)
        defer { clean(store) }

        // Process one: the connection drops after the request left.
        let backend = ScriptedWallet(store: store, dropFirst: true)
        let first = wallet(store, backend)
        pay(first, note: "Rent")
        #expect(await waitUntil { failedAttempt(first)?.1 == .noConnection })
        let sent = try #require(backend.sent.first)
        #expect(backend.storedAtSend.first??.key == sent.key, "the key was written BEFORE the request left")
        #expect(backend.storedAtSend.first??.instruction == sent.instruction)
        #expect(try store.load(userID: userOne.id)?.key == sent.key)

        // Process two, with nothing in memory: the payment comes back as 'never saw how it ended', with no network call.
        let second = wallet(store, backend)
        let restored = try #require(failedAttempt(second))
        #expect(restored.1 == .interrupted)
        #expect(restored.0.key == sent.key)
        #expect(backend.sent.count == 1)
        second.send.tryAgain()
        #expect(await waitUntil { if case .sent = second.send.screen { true } else { false } })
        #expect(backend.sent.map(\.key) == [sent.key, sent.key])
        #expect(backend.sent.map(\.instruction) == [sent.instruction, sent.instruction])
        #expect(try store.load(userID: userOne.id) == nil, "a posted payment leaves nothing behind")

        // Process three: nothing is waiting.
        let third = wallet(store, backend)
        #expect(third.send.unresolved == nil)
    }

    @Test("a note-less payment goes out and comes back without a note, through the real store")
    func noteless() async throws {
        let store = KeychainPendingTransferStore(service: "test.kobolink.transfer.\(UUID().uuidString)")
        defer { clean(store) }
        let backend = ScriptedWallet(store: store, dropFirst: false)
        let controller = wallet(store, backend)
        pay(controller)
        #expect(await waitUntil { if case .sent = controller.send.screen { true } else { false } })
        #expect(backend.sent.first?.instruction.note == nil)
        #expect(backend.storedAtSend.first??.instruction.note == nil)
    }

    @Test("signing out removes the user's payment from the Keychain, after writing what it owes, and the next user finds nothing")
    func signOutClearsKeychain() async throws {
        let store = KeychainPendingTransferStore(service: "test.kobolink.transfer.\(UUID().uuidString)")
        defer { clean(store) }
        let backend = ScriptedWallet(store: store, dropFirst: true)
        let controller = wallet(store, backend)
        pay(controller)
        #expect(await waitUntil { failedAttempt(controller)?.1 == .noConnection })
        #expect(controller.hasSavedPayments)

        #expect(controller.prepareSignOut())
        let owed = try #require(try store.loadObligation())
        #expect(owed.entries.map(\.code) == [userOne.id])
        #expect(try store.load(userID: userOne.id) != nil, "nothing is removed until the sign-out happens")

        controller.sessionDidChange(.signedOutByChoice)
        #expect(try store.load(userID: userOne.id) == nil)
        #expect(try store.loadObligation() == nil)
        #expect(controller.send.screen == .idle)

        let next = wallet(store, backend, user: userTwo)
        #expect(next.send.screen == .idle)
    }

    @Test("an involuntary end leaves the Keychain alone, and another user's session never loads or removes it")
    func involuntaryEnd() async throws {
        let store = KeychainPendingTransferStore(service: "test.kobolink.transfer.\(UUID().uuidString)")
        defer { clean(store) }
        let backend = ScriptedWallet(store: store, dropFirst: true)
        let controller = wallet(store, backend)
        pay(controller)
        #expect(await waitUntil { failedAttempt(controller)?.1 == .noConnection })
        let key = try #require(backend.sent.first?.key)

        controller.sessionDidChange(.ended)
        #expect(try store.load(userID: userOne.id)?.key == key)
        controller.sessionDidChange(.signedIn(userTwo))
        #expect(controller.send.unresolved == nil)
        #expect(try store.load(userID: userOne.id)?.key == key, "the other user's session did not remove it")
        controller.sessionDidChange(.signedIn(userOne))
        #expect(failedAttempt(controller)?.0.key == key, "and the same user gets it back")
    }

    @Test("an unreadable slot blocks the form instead of reading as nothing; forgetting it is the way out")
    func unreadableSlot() throws {
        let service = "test.kobolink.transfer.\(UUID().uuidString)"
        let store = KeychainPendingTransferStore(service: service)
        defer { clean(store) }
        let item: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: userOne.id,
            kSecValueData: Data("future format".utf8),
        ]
        #expect(SecItemAdd(item as CFDictionary, nil) == errSecSuccess)
        let controller = wallet(store, ScriptedWallet(store: store, dropFirst: false))
        #expect(controller.send.screen == .blocked(.undecodable))
        controller.send.forgetSavedPayments()
        #expect(controller.send.screen == .idle)
        #expect(try store.all().isEmpty)
    }
}
