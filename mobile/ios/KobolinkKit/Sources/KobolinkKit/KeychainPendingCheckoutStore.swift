import Foundation
import Security

/// The unsettled payment attempts in the iOS Keychain: one generic password item per link code.
///
/// - `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable once the device has been unlocked
///   after a restart, so a launch the system starts in the background can still find the attempt; never
///   migrated to another device by a backup or restore.
/// - `kSecAttrSynchronizable: false`: never synced through iCloud Keychain.
/// - Excluded from backups BY CONSTRUCTION: the only home is a `ThisDeviceOnly` Keychain item, so there
///   is no file for a backup to include, nothing under `Documents`, `Library` or `UserDefaults`, and no
///   `isExcludedFromBackup` flag to forget to set.
/// - One slot per link code per DEVICE, found whatever the session is doing: a cold start reads it
///   before any session has resolved.
///
/// The item survives the app being deleted, like the session token, and unlike the token it is NOT purged
/// on the first launch of a reinstall: a payer who deleted the app after an interrupted attempt and
/// tapped the link again is exactly who needs the same key back, and a phone that changes hands is
/// erased, which empties the Keychain. (A session token is the opposite case: it authorises a
/// merchant, so a leftover one is never trusted.)
///
/// Nothing here logs. The record holds the payer's name and email; only `OSStatus` values reach errors.
public struct KeychainPendingCheckoutStore: PendingCheckoutStore {
    public static let defaultService = "com.folusayo.kobolink.pending-checkout"

    private let service: String

    /// `service` is a parameter only so tests can use a unique one and not touch a real attempt.
    public init(service: String = KeychainPendingCheckoutStore.defaultService) {
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

    public func load(_ code: LinkCode) throws(PendingStoreError) -> PendingCheckout? {
        var query = identity(code.value)
        query[kSecReturnData] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data, let pending = try? PendingCheckout.decoded(from: data),
                pending.request.code == code
            else { throw PendingStoreError(operation: .read, kind: .undecodable, status: status) }
            return pending
        case errSecItemNotFound:
            return nil
        default:
            throw PendingStoreError(operation: .read, status: status)
        }
    }

    public func save(_ pending: PendingCheckout) throws(PendingStoreError) {
        let data: Data
        do { data = try pending.encoded() } catch { throw PendingStoreError(operation: .write, kind: .undecodable) }
        let slot = identity(pending.request.code.value)
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

    public func remove(_ code: LinkCode) throws(PendingStoreError) {
        try remove(slotID: code.value)
    }

    public func remove(slotID: String) throws(PendingStoreError) {
        let status = SecItemDelete(identity(slotID) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw PendingStoreError(operation: .remove, status: status)
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

    public func loadObligation() throws(PendingStoreError) -> CleanupObligation? {
        var query = obligationIdentity
        query[kSecReturnData] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data, let obligation = try? JSONDecoder().decode(CleanupObligation.self, from: data) else {
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

    public func saveObligation(_ obligation: CleanupObligation) throws(PendingStoreError) {
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

    public func all() throws(PendingStoreError) -> [PendingSlot] {
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
                if let data = item[kSecValueData as String] as? Data, let pending = try? PendingCheckout.decoded(from: data),
                    pending.request.code.value == account
                {
                    return .pending(pending)
                }
                return .unreadable(slotID: account)
            }
        default:
            throw PendingStoreError(operation: .list, status: status)
        }
    }
}
