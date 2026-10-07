import Foundation

@testable import KobolinkKit

// Every credential below is invented for these tests. None belongs to a real account.

enum Fixture {
    static let email = "merchant@example.test"
    static let password = "correct-horse-battery-staple"
    static let user = SignedInUser(id: "usr_test01", email: email, displayName: "Test Merchant", role: .merchant)
    static let otherUser = SignedInUser(id: "usr_test02", email: "other@example.test", displayName: "Other Person", role: .merchant)

    static let tokenA = SessionToken("tokA_" + String(repeating: "a1B2", count: 10))!
    static let tokenB = SessionToken("tokB_" + String(repeating: "c3D4", count: 10))!
}

/// Lets a test hold a call in flight and release it when it chooses.
final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if opened {
                lock.unlock()
                continuation.resume()
            } else {
                waiters.append(continuation)
                lock.unlock()
            }
        }
    }

    func open() {
        lock.lock()
        opened = true
        let pending = waiters
        waiters = []
        lock.unlock()
        pending.forEach { $0.resume() }
    }
}

/// A scripted `AuthServing`. Records what it was asked, never the password.
final class FakeAuth: AuthServing, @unchecked Sendable {
    enum Call: Equatable {
        case login(email: String)
        case currentUser
        case logout(SessionToken)
    }

    private let lock = NSLock()
    private var recorded: [Call] = []

    var loginResult: Result<AuthSession, APIError> = .success(AuthSession(user: Fixture.user, token: Fixture.tokenA))
    var meResult: Result<SignedInUser, APIError> = .success(Fixture.user)
    var logoutResult: Result<Void, APIError> = .success(())
    var loginGate: Gate?
    var meGate: Gate?
    var logoutGate: Gate?

    var calls: [Call] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    private func record(_ call: Call) {
        lock.lock()
        recorded.append(call)
        lock.unlock()
    }

    func login(email: String, password: String) async throws(APIError) -> AuthSession {
        record(.login(email: email))
        await loginGate?.wait()
        return try loginResult.get()
    }

    func currentUser() async throws(APIError) -> SignedInUser {
        record(.currentUser)
        await meGate?.wait()
        return try meResult.get()
    }

    func logout(revoking token: SessionToken) async throws(APIError) {
        record(.logout(token))
        await logoutGate?.wait()
        try logoutResult.get()
    }
}

/// Poll until `condition` holds, or fail the test after a second. For work that hops threads.
@MainActor
func waitUntil(_ condition: @MainActor () -> Bool) async -> Bool {
    for _ in 0..<200 {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return condition()
}
