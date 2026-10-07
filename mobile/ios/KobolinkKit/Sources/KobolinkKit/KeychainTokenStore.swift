import Foundation
import Security

/// The session token in the iOS Keychain, as a generic password item.
///
/// - `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable once the device has been
///   unlocked after a restart (so a background launch can still resolve the session), never
///   migrated to another device through a backup or restore, and gone from the device if the passcode
///   is removed. It is not the stricter "when unlocked" class because the app may be started in the
///   background by the system while the phone is locked.
/// - `kSecAttrSynchronizable: false`: never synced through iCloud Keychain. A session belongs to
///   the device it signed in on; the server can revoke it per session.
/// - The item survives the app being deleted. `SessionController` purges it on the first launch of
///   a fresh install, using an `InstallMarker`.
///
/// Nothing here logs. An `OSStatus` reaches an error value; the token's characters only ever travel
/// as `Data` into and out of the Security framework.
public struct KeychainTokenStore: TokenStore {
    public static let defaultService = "com.folusayo.kobolink.session"
    public static let account = "session-token"

    private let service: String

    /// `service` is a parameter only so tests can use a unique one and not touch a real session.
    public init(service: String = KeychainTokenStore.defaultService) {
        self.service = service
    }

    private var identity: [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: Self.account,
            kSecAttrSynchronizable: kCFBooleanFalse as Any,
        ]
    }

    public func readToken() throws(TokenStoreError) -> SessionToken? {
        var query = identity
        query[kSecReturnData] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data,
                let text = String(data: data, encoding: .utf8),
                let token = SessionToken(text)
            else { throw TokenStoreError(operation: .read, kind: .corrupt, status: status) }
            return token
        case errSecItemNotFound:
            return nil
        default:
            throw TokenStoreError(operation: .read, status: status)
        }
    }

    public func saveToken(_ token: SessionToken) throws(TokenStoreError) {
        let data = Data(token.reveal().utf8)
        let accessible = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        // Update first, then add: a delete-then-add would leave no token at all if the add failed.
        let updated = SecItemUpdate(
            identity as CFDictionary,
            [kSecValueData: data, kSecAttrAccessible: accessible] as CFDictionary
        )
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else {
            throw TokenStoreError(operation: .save, status: updated)
        }

        var item = identity
        item[kSecValueData] = data
        item[kSecAttrAccessible] = accessible
        let added = SecItemAdd(item as CFDictionary, nil)
        guard added == errSecSuccess else { throw TokenStoreError(operation: .save, status: added) }
    }

    public func clearToken() throws(TokenStoreError) {
        let status = SecItemDelete(identity as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw TokenStoreError(operation: .clear, status: status)
        }
    }
}
