import Foundation

/// One payment: the exact request, and the idempotency key it is bound to. It exists from just before the request
/// leaves until something definite replaces it (a success, a refusal the server stores under the key, or the
/// sender's confirmed "I checked: it didn't go through").
///
/// It holds a recipient's number, an amount and a note, so it lives only in the Keychain
/// (`KeychainPendingTransferStore`), in a slot of the SIGNED-IN USER: the server scopes idempotency by user id too,
/// so a key is only ever meaningful to the person who made it.
public struct TransferAttempt: Equatable, Sendable {
    public let key: String
    /// The signed-in user who made it.
    public let userID: String
    public let instruction: TransferInstruction
    /// The name the scanned QR code carried, if the number came from one. WHATEVER ITS CREATOR WROTE: it is shown
    /// only labelled as unverified, never as the identity of the recipient, and never in place of the number.
    public let payeeName: String?
    public let createdAt: Date

    public init(key: String, userID: String, instruction: TransferInstruction, payeeName: String?, createdAt: Date) {
        self.key = key
        self.userID = userID
        self.instruction = instruction
        self.payeeName = payeeName
        self.createdAt = createdAt
    }
}

// MARK: - Wire form

extension TransferAttempt: Codable {
    private enum CodingKeys: String, CodingKey {
        case version, key, userID, toPhone, amountKobo, note, payeeName, createdAt
    }

    static let formatVersion = 1

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard try c.decode(Int.self, forKey: .version) == Self.formatVersion else {
            throw DecodingError.dataCorruptedError(forKey: .version, in: c, debugDescription: "Unknown version")
        }
        let key = try c.decode(String.self, forKey: .key)
        guard IdempotencyKey.isValid(key) else {
            throw DecodingError.dataCorruptedError(forKey: .key, in: c, debugDescription: "Not an idempotency key")
        }
        let userID = try c.decode(String.self, forKey: .userID)
        guard !userID.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .userID, in: c, debugDescription: "No user")
        }
        let phone = try c.decode(String.self, forKey: .toPhone)
        guard NigerianPhone.isE164(phone) else {
            throw DecodingError.dataCorruptedError(forKey: .toPhone, in: c, debugDescription: "Not a phone number")
        }
        let amount = try c.decode(Int.self, forKey: .amountKobo)
        guard Kobo.isValidAmountKobo(amount) else {
            throw DecodingError.dataCorruptedError(forKey: .amountKobo, in: c, debugDescription: "Not a transferable amount")
        }
        let note = try c.decodeIfPresent(String.self, forKey: .note)
        if let note, note.isEmpty || JavaScriptText.length(note) > TransferInstruction.noteMaxLength {
            throw DecodingError.dataCorruptedError(forKey: .note, in: c, debugDescription: "Not a note")
        }
        self.init(
            key: key,
            userID: userID,
            instruction: TransferInstruction(toPhone: phone, amountKobo: amount, note: note),
            payeeName: try c.decodeIfPresent(String.self, forKey: .payeeName),
            createdAt: Date(timeIntervalSince1970: TimeInterval(try c.decode(Int.self, forKey: .createdAt)))
        )
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.formatVersion, forKey: .version)
        try c.encode(key, forKey: .key)
        try c.encode(userID, forKey: .userID)
        try c.encode(instruction.toPhone, forKey: .toPhone)
        try c.encode(instruction.amountKobo, forKey: .amountKobo)
        // Absent, not null: the stored request is the request that is sent.
        try c.encodeIfPresent(instruction.note, forKey: .note)
        try c.encodeIfPresent(payeeName, forKey: .payeeName)
        // Whole seconds: nothing reads it back as anything finer, and an integer cannot be mistaken for money.
        try c.encode(Int(createdAt.timeIntervalSince1970), forKey: .createdAt)
    }

    /// The record as bytes, for the Keychain.
    func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self)
    }

    static func decoded(from data: Data) throws -> TransferAttempt {
        try JSONDecoder().decode(TransferAttempt.self, from: data)
    }
}

// MARK: - The store

/// One entry of `PendingTransferStore.all()`.
public enum TransferSlot: Equatable, Sendable {
    case pending(TransferAttempt)
    /// A slot that exists but cannot be decoded; `slotID` is what `remove(slotID:)` takes.
    case unreadable(slotID: String)

    var slotID: String {
        switch self {
        case .pending(let attempt): attempt.userID
        case .unreadable(let slotID): slotID
        }
    }
}

/// Where an unsettled transfer is remembered so that it outlives the screen, the scene and the process. One slot
/// per USER on the device: a cold start finds it as soon as that user is known, and nobody else's session ever
/// loads it.
///
/// Every call is synchronous and durable. `save` returning means the record is in secure storage, which is what
/// lets `SendController` write it BEFORE the request leaves: if it cannot be written, nothing is sent. There is no
/// fallback to any other storage. Errors are `PendingStoreError` (the same shape as the checkout's, carrying an
/// `OSStatus` and never any part of the record).
public protocol PendingTransferStore: Sendable {
    /// `nil` means nothing is stored. A throw is "could not find out" (`unavailable`) or "something is there I
    /// cannot read" (`undecodable`), and is never read as "nothing".
    func load(userID: String) throws(PendingStoreError) -> TransferAttempt?

    /// Durably record the attempt in its user's slot, replacing what was there.
    func save(_ attempt: TransferAttempt) throws(PendingStoreError)

    /// Forget a user's slot; removing a slot that is not there is not an error.
    func remove(userID: String) throws(PendingStoreError)

    /// Forget a slot by its raw id, for an `unreadable` one.
    func remove(slotID: String) throws(PendingStoreError)

    /// Every slot on the device.
    func all() throws(PendingStoreError) -> [TransferSlot]

    /// The cleanup a sign-out still owes (`SignOutObligation`: slot id and key). A throw is "could not find out",
    /// never "nothing owed".
    func loadObligation() throws(PendingStoreError) -> SignOutObligation?
    func saveObligation(_ obligation: SignOutObligation) throws(PendingStoreError)
    func clearObligation() throws(PendingStoreError)
}

/// A store in memory, for tests and previews. It does not persist anything, so it must never be what a shipping
/// build uses. Each failure can be switched on.
public final class InMemoryPendingTransferStore: PendingTransferStore, @unchecked Sendable {
    private let lock = NSLock()
    private var slots: [String: TransferSlot] = [:]
    private var failures: [PendingStoreError.Operation: PendingStoreError.Kind] = [:]
    private var storedObligation: SignOutObligation?
    private var savedLog: [TransferAttempt] = []

    public init() {}

    /// Make every later `operation` throw `kind`, until `heal()`.
    public func fail(_ operation: PendingStoreError.Operation, as kind: PendingStoreError.Kind = .unavailable) {
        lock.lock()
        defer { lock.unlock() }
        failures[operation] = kind
    }

    public func heal() {
        lock.lock()
        defer { lock.unlock() }
        failures = [:]
    }

    /// Put something unreadable in a user's slot, as a downgraded or corrupted Keychain item would be.
    public func plantUnreadable(userID: String) {
        lock.lock()
        defer { lock.unlock() }
        slots[userID] = .unreadable(slotID: userID)
    }

    private func check(_ operation: PendingStoreError.Operation) throws(PendingStoreError) {
        if let kind = failures[operation] { throw PendingStoreError(operation: operation, kind: kind, status: -1) }
    }

    public func load(userID: String) throws(PendingStoreError) -> TransferAttempt? {
        lock.lock()
        defer { lock.unlock() }
        try check(.read)
        switch slots[userID] {
        case .pending(let attempt): return attempt
        case .unreadable: throw PendingStoreError(operation: .read, kind: .undecodable, status: -1)
        case nil: return nil
        }
    }

    public func save(_ attempt: TransferAttempt) throws(PendingStoreError) {
        lock.lock()
        defer { lock.unlock() }
        try check(.write)
        slots[attempt.userID] = .pending(attempt)
        savedLog.append(attempt)
    }

    public func remove(userID: String) throws(PendingStoreError) {
        lock.lock()
        defer { lock.unlock() }
        try check(.remove)
        slots[userID] = nil
    }

    public func remove(slotID: String) throws(PendingStoreError) {
        lock.lock()
        defer { lock.unlock() }
        try check(.remove)
        slots[slotID] = nil
    }

    public func all() throws(PendingStoreError) -> [TransferSlot] {
        lock.lock()
        defer { lock.unlock() }
        try check(.list)
        return slots.keys.sorted().compactMap { slots[$0] }
    }

    public func loadObligation() throws(PendingStoreError) -> SignOutObligation? {
        lock.lock()
        defer { lock.unlock() }
        try check(.obligation)
        return storedObligation
    }

    public func saveObligation(_ obligation: SignOutObligation) throws(PendingStoreError) {
        lock.lock()
        defer { lock.unlock() }
        try check(.obligation)
        storedObligation = obligation
    }

    public func clearObligation() throws(PendingStoreError) {
        lock.lock()
        defer { lock.unlock() }
        try check(.obligation)
        storedObligation = nil
    }

    /// The obligation as stored, without going through the failure switches, for assertions.
    public var obligation: SignOutObligation? {
        lock.lock()
        defer { lock.unlock() }
        return storedObligation
    }

    /// Everything stored, without going through the failure switches, for assertions.
    public var snapshot: [TransferAttempt] {
        lock.lock()
        defer { lock.unlock() }
        return slots.keys.sorted().compactMap { if case .pending(let a) = slots[$0] { a } else { nil } }
    }

    /// Every attempt ever saved, in order, for asserting what was written and when.
    public var everSaved: [TransferAttempt] {
        lock.lock()
        defer { lock.unlock() }
        return savedLog
    }
}
