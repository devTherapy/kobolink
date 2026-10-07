import Foundation

/// Tells a fresh install from a relaunch.
///
/// The Keychain outlives the app: delete Kobolink and reinstall it, and the old session token is
/// still there. `UserDefaults` does not outlive the app. So the first launch of an install finds no
/// marker, and `SessionController` removes whatever token is in the Keychain before trusting it.
///
/// The marker holds one boolean and nothing about the session. Keeping it in `UserDefaults` is
/// deliberate and is not a place for the token: the rule is that the token never goes to
/// `UserDefaults`, and a test checks that no value in the marker's suite ever equals one.
public protocol InstallMarker: Sendable {
    /// Has this install already completed its first-launch purge?
    var isSet: Bool { get }
    func set()
}

public struct UserDefaultsInstallMarker: InstallMarker {
    public static let key = "kobolink.installMarker.v1"
    private let suiteName: String?

    /// `suiteName` is a parameter so tests can use a throwaway suite.
    public init(suiteName: String? = nil) {
        self.suiteName = suiteName
    }

    // `UserDefaults` is not `Sendable` in every SDK, and a stored one would make this struct
    // non-Sendable; looking it up per call keeps the marker a plain value.
    private var defaults: UserDefaults {
        suiteName.flatMap(UserDefaults.init(suiteName:)) ?? .standard
    }

    public var isSet: Bool { defaults.bool(forKey: Self.key) }
    public func set() { defaults.set(true, forKey: Self.key) }
}

/// A marker in memory: a fresh one is "a fresh install". For tests.
public final class InMemoryInstallMarker: InstallMarker, @unchecked Sendable {
    private let lock = NSLock()
    private var value: Bool

    public init(isSet: Bool = false) { value = isSet }

    public var isSet: Bool {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    public func set() {
        lock.lock()
        defer { lock.unlock() }
        value = true
    }
}
