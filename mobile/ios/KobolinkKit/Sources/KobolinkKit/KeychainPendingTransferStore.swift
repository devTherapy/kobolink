import Foundation
import Security

/// The unsettled wallet transfers in the iOS Keychain: one generic password item per signed-in user.
///
/// The same item attributes as `KeychainPendingCheckoutStore`, for the same reasons:
/// - `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable once the device has been unlocked after a
///   restart; never migrated to another device by a backup or restore.
/// - `kSecAttrSynchronizable: false`: never synced through iCloud Keychain.
/// - Excluded from backups BY CONSTRUCTION: the only home is a `ThisDeviceOnly` Keychain item, so there is no
///   file for a backup to include, nothing under `Documents`, `Library` or `UserDefaults`.
/// - Written with update-then-add, never delete-then-add: a failed add must not leave no record at all.
///
/// The slot (`kSecAttrAccount`) is the USER ID. That is what scopes a payment to the signed-in user: nobody else's
/// session ever asks for it, and the server scopes the idempotency key by user id as well.
///
/// The item survives the app being deleted, like the session token. It is NOT purged on a reinstall: someone who
/// deleted the app after an interrupted transfer and signed back in is exactly who needs the same key back.
///
/// Nothing here logs. The record holds a recipient's number, an amount and a note; only `OSStatus` values reach
/// errors.
public struct KeychainPendingTransferStore: PendingTransferStore {
    public static let defaultService = "com.folusayo.kobolink.pending-transfer"

    private let service: String

    /// `service` is a parameter only so tests can use a unique one and not touch a real attempt.
    public init(service: String = KeychainPendingTransferStore.defaultService) {
        self.service = service
    }

    private func identity(_ slotID: String) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: slotID,
            kSecAttrSynchronizable: kCFBooleanFalse as Any,
        ]
    }

    public func load(userID: String) throws(PendingStoreError) -> TransferAttempt? {
        var query = identity(userID)
        query[kSecReturnData] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data, let attempt = try? TransferAttempt.decoded(from: data), attempt.userID == userID
            else { throw PendingStoreError(operation: .read, kind: .undecodable, status: status) }
            return attempt
        case errSecItemNotFound:
            return nil
        default:
            throw PendingStoreError(operation: .read, status: status)
        }
    }

    public func save(_ attempt: TransferAttempt) throws(PendingStoreError) {
        let data: Data
        do { data = try attempt.encoded() } catch { throw PendingStoreError(operation: .write, kind: .undecodable) }
        let slot = identity(attempt.userID)
        let accessible = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        // Update first, then add: a delete-then-add would leave no record at all if the add failed.
        let updated = SecItemUpdate(
            slot as CFDictionary,
            [kSecValueData: data, kSecAttrAccessible: accessible] as CFDictionary
        )
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw PendingStoreError(operation: .write, status: updated) }

        var item = slot
        item[kSecValueData] = data
        item[kSecAttrAccessible] = accessible
        let added = SecItemAdd(item as CFDictionary, nil)
        guard added == errSecSuccess else { throw PendingStoreError(operation: .write, status: added) }
    }

    public func remove(userID: String) throws(PendingStoreError) {
        try remove(slotID: userID)
    }

    public func remove(slotID: String) throws(PendingStoreError) {
        let status = SecItemDelete(identity(slotID) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw PendingStoreError(operation: .remove, status: status)
        }
    }

    public func all() throws(PendingStoreError) -> [TransferSlot] {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrSynchronizable: kCFBooleanFalse as Any,
            kSecReturnAttributes: kCFBooleanTrue as Any,
            kSecReturnData: kCFBooleanTrue as Any,
            kSecMatchLimit: kSecMatchLimitAll,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecItemNotFound:
            return []
        case errSecSuccess:
            let items = (result as? [[String: Any]]) ?? []
            return items.compactMap { item in
                guard let account = item[kSecAttrAccount as String] as? String else { return nil }
                if let data = item[kSecValueData as String] as? Data, let attempt = try? TransferAttempt.decoded(from: data),
                    attempt.userID == account
                {
                    return .pending(attempt)
                }
                return .unreadable(slotID: account)
            }
        default:
            throw PendingStoreError(operation: .list, status: status)
        }
    }

    // MARK: The owed cleanup

    /// Kept under a service of its own so that `all()` never lists it as a slot.
    private var obligationIdentity: [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service + ".obligation",
            kSecAttrAccount: "cleanup",
            kSecAttrSynchronizable: kCFBooleanFalse as Any,
        ]
    }

    public func loadObligation() throws(PendingStoreError) -> SignOutObligation? {
        var query = obligationIdentity
        query[kSecReturnData] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data, let obligation = try? JSONDecoder().decode(SignOutObligation.self, from: data) else {
                // Something is there that cannot be read: owed, and not known what. The caller must not read it as "nothing".
                throw PendingStoreError(operation: .obligation, kind: .undecodable, status: status)
            }
            return obligation
        case errSecItemNotFound:
            return nil
        default:
            throw PendingStoreError(operation: .obligation, status: status)
        }
    }

    public func saveObligation(_ obligation: SignOutObligation) throws(PendingStoreError) {
        let data: Data
        do { data = try JSONEncoder().encode(obligation) } catch { throw PendingStoreError(operation: .obligation, kind: .undecodable) }
        let accessible = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let updated = SecItemUpdate(
            obligationIdentity as CFDictionary, [kSecValueData: data, kSecAttrAccessible: accessible] as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw PendingStoreError(operation: .obligation, status: updated) }
        var item = obligationIdentity
        item[kSecValueData] = data
        item[kSecAttrAccessible] = accessible
        let added = SecItemAdd(item as CFDictionary, nil)
        guard added == errSecSuccess else { throw PendingStoreError(operation: .obligation, status: added) }
    }

    public func clearObligation() throws(PendingStoreError) {
        let status = SecItemDelete(obligationIdentity as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw PendingStoreError(operation: .obligation, status: status)
        }
    }
}
