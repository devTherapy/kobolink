import Foundation

/// The session token the API hands a mobile client (`AuthResponse.token`). It is a bearer
/// credential: whoever holds it is signed in.
///
/// The type exists so the token cannot leak by accident. `print`, string interpolation, `dump`,
/// `String(reflecting:)`, a crash report's argument description and a `#expect` failure message all
/// show `<redacted>`. The one way to the characters is `reveal()`, and its only callers are the
/// Keychain write and the `Authorization` header.
///
/// Never put it in a URL, a log line, `UserDefaults`, a file, or a notification payload.
public struct SessionToken: Equatable, Hashable, Sendable, CustomStringConvertible, CustomDebugStringConvertible,
    CustomReflectable
{
    private let rawValue: String

    /// `nil` unless `rawValue` is something that can safely sit in an HTTP header: non-empty
    /// printable ASCII with no space. A token with a newline in it would otherwise let the
    /// `Authorization` header carry a second header.
    public init?(_ rawValue: String) {
        guard !rawValue.isEmpty,
            rawValue.utf8.allSatisfy({ (0x21...0x7E).contains($0) })
        else { return nil }
        self.rawValue = rawValue
    }

    /// The token's characters. Call it only where the token is written to the Keychain or sent.
    public func reveal() -> String { rawValue }

    public var description: String { "<redacted>" }
    public var debugDescription: String { "<redacted>" }
    public var customMirror: Mirror { Mirror(self, children: []) }
}

/// Why a token could not be read, saved or removed. It carries the Security framework's `OSStatus`
/// and never any part of the token.
public struct TokenStoreError: Error, Equatable, Sendable, CustomStringConvertible {
    public enum Operation: String, Sendable { case read, save, clear }

    public enum Kind: Equatable, Sendable {
        /// The store refused or could not be reached (a locked Keychain, a Keychain that is not there
        /// yet after a restart). The token may still exist.
        case unavailable
        /// Something is stored but it is not a token this app wrote.
        case corrupt
    }

    public let operation: Operation
    public let kind: Kind
    /// The `OSStatus`, or `0` when there is none.
    public let status: Int32

    public init(operation: Operation, kind: Kind = .unavailable, status: Int32 = 0) {
        self.operation = operation
        self.kind = kind
        self.status = status
    }

    public var description: String {
        "TokenStoreError(\(operation.rawValue), \(kind), status \(status))"
    }
}

/// The one door to the persisted session token. The real implementation is `KeychainTokenStore`;
/// nothing else in the app may keep the token anywhere that outlives the process.
///
/// All three calls are synchronous and durable: when `saveToken` or `clearToken` returns, the change
/// is in the Keychain, so killing the process right after cannot bring a signed-out session back.
/// There is no fallback: a store that cannot hold the token throws, and callers treat that as "not
/// signed in", never as "keep it somewhere else".
public protocol TokenStore: Sendable {
    /// `nil` means nothing is stored. A throw means "could not find out", which is different:
    /// the token may still be there.
    func readToken() throws(TokenStoreError) -> SessionToken?
    func saveToken(_ token: SessionToken) throws(TokenStoreError)
    func clearToken() throws(TokenStoreError)
}

/// A `TokenStore` that keeps the token in memory, for tests, SwiftUI previews and the unit tests of
/// everything that depends on a store. It does not persist anything, so it must never be what a
/// shipping build uses. Each failure can be switched on to exercise the paths a healthy Keychain
/// never takes.
public final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var token: SessionToken?
    private var failures: [TokenStoreError.Operation: TokenStoreError.Kind] = [:]

    public init(token: SessionToken? = nil) {
        self.token = token
    }

    /// Make every later `operation` throw `kind`, until `heal()`.
    public func fail(_ operation: TokenStoreError.Operation, as kind: TokenStoreError.Kind = .unavailable) {
        lock.lock()
        defer { lock.unlock() }
        failures[operation] = kind
    }

    public func heal() {
        lock.lock()
        defer { lock.unlock() }
        failures = [:]
    }

    public func readToken() throws(TokenStoreError) -> SessionToken? {
        lock.lock()
        defer { lock.unlock() }
        if let kind = failures[.read] { throw TokenStoreError(operation: .read, kind: kind, status: -1) }
        return token
    }

    public func saveToken(_ token: SessionToken) throws(TokenStoreError) {
        lock.lock()
        defer { lock.unlock() }
        if let kind = failures[.save] { throw TokenStoreError(operation: .save, kind: kind, status: -1) }
        self.token = token
    }

    public func clearToken() throws(TokenStoreError) {
        lock.lock()
        defer { lock.unlock() }
        if let kind = failures[.clear] { throw TokenStoreError(operation: .clear, kind: kind, status: -1) }
        token = nil
    }
}
