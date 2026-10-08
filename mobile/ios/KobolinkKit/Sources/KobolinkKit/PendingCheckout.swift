import Foundation

/// Who made a payment attempt, recorded only so that the right sign-out can forget it.
///
/// ONE RULE, used everywhere (`CheckoutController` is the only code that applies it):
///
/// - `payer`: made while nobody was signed in on this device (no stored session). A payer's attempt is
///   never cleared by a merchant signing out or changing; only a confirmed server refusal or an explicit,
///   confirmed "Start a new payment" removes it.
/// - `session(userID:)`: made while a session existed on the device, whether it was `signedIn`, still
///   `resolving` or `offline`. `userID` is nil until the server has confirmed who the session belongs to,
///   and is filled in then (cold-start `/me` confirming the same stored token), so an attempt made in
///   the seconds before the check finishes is never ownerless.
///
/// What each session event does with `session` attempts:
/// - explicit sign-out: removes every one of them, whoever made it (sign-out ends the merchant context
///   on this device);
/// - the check confirms user U: attempts with no user id become U's; attempts made by another user are
///   removed;
/// - a sign-in with credentials as U: attempts with no user id are adopted by U exactly as above, and only
///   those made by another CONFIRMED user are removed. A sign-in NEVER drops an unconfirmed attempt: it may
///   be the same person's, with an outcome nobody has seen (their token expired while the first request was
///   in the air), and forgetting it would let the form mint a second key. If the person is someone else, the
///   attempt costs them a second look at "Payment started" or "Try Again" (it shows only the amount, the
///   merchant and the reference), and a sign-out removes it. An adoption that cannot be saved keeps the
///   attempt and is retried;
/// - involuntary expiry (a 401): removes nothing.
public enum AttemptOwner: Equatable, Hashable, Sendable {
    case payer
    case session(userID: String?)

    var isSession: Bool {
        if case .session = self { true } else { false }
    }
}

/// A payment attempt whose outcome is not settled. It exists from just before the request leaves until
/// something definite replaces it (a refusal the server stores under the key, or the person's confirmed
/// "Start a new payment"); a started checkout stays too, because `verify` (feature I4) is what settles it.
///
/// It holds the payer's name and email, which are part of the request the key is bound to, so it lives
/// only in the Keychain (`KeychainPendingCheckoutStore`).
public struct PendingCheckout: Equatable, Sendable {
    public let key: String
    public let request: InitializeRequest
    /// Set once `initialize` answered 201. With no reference the outcome is UNKNOWN: the server may have
    /// stored the request, so the only safe retry is this exact request under this exact key.
    public var reference: String?
    /// The amount the server echoed with the reference.
    public var confirmedAmountKobo: Int?
    public var owner: AttemptOwner
    /// What the link looked like when the attempt was made, kept so the screen can say what was being
    /// paid without a network call (a cold start offline still shows the attempt).
    public let merchantName: String
    public let title: String
    public let createdAt: Date

    public init(
        key: String,
        request: InitializeRequest,
        reference: String? = nil,
        confirmedAmountKobo: Int? = nil,
        owner: AttemptOwner,
        merchantName: String,
        title: String,
        createdAt: Date
    ) {
        self.key = key
        self.request = request
        self.reference = reference
        self.confirmedAmountKobo = confirmedAmountKobo
        self.owner = owner
        self.merchantName = merchantName
        self.title = title
        self.createdAt = createdAt
    }
}

// MARK: - Wire form

extension PendingCheckout: Codable {
    private enum CodingKeys: String, CodingKey {
        case version, key, code, amountKobo, payerName, payerEmail
        case reference, confirmedAmountKobo, ownerKind, ownerUserID
        case merchantName, title, createdAt
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
        let owner: AttemptOwner
        switch try c.decode(String.self, forKey: .ownerKind) {
        case "payer": owner = .payer
        case "session": owner = .session(userID: try c.decodeIfPresent(String.self, forKey: .ownerUserID))
        default:
            throw DecodingError.dataCorruptedError(forKey: .ownerKind, in: c, debugDescription: "Unknown owner")
        }
        self.init(
            key: key,
            request: InitializeRequest(
                code: try c.decode(LinkCode.self, forKey: .code),
                amountKobo: try c.decode(Int.self, forKey: .amountKobo),
                payerName: try c.decode(String.self, forKey: .payerName),
                payerEmail: try c.decode(String.self, forKey: .payerEmail)
            ),
            reference: try c.decodeIfPresent(String.self, forKey: .reference),
            confirmedAmountKobo: try c.decodeIfPresent(Int.self, forKey: .confirmedAmountKobo),
            owner: owner,
            merchantName: try c.decode(String.self, forKey: .merchantName),
            title: try c.decode(String.self, forKey: .title),
            createdAt: Date(timeIntervalSince1970: TimeInterval(try c.decode(Int.self, forKey: .createdAt)))
        )
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.formatVersion, forKey: .version)
        try c.encode(key, forKey: .key)
        try c.encode(request.code, forKey: .code)
        try c.encode(request.amountKobo, forKey: .amountKobo)
        try c.encode(request.payerName, forKey: .payerName)
        try c.encode(request.payerEmail, forKey: .payerEmail)
        try c.encodeIfPresent(reference, forKey: .reference)
        try c.encodeIfPresent(confirmedAmountKobo, forKey: .confirmedAmountKobo)
        switch owner {
        case .payer:
            try c.encode("payer", forKey: .ownerKind)
        case .session(let userID):
            try c.encode("session", forKey: .ownerKind)
            try c.encodeIfPresent(userID, forKey: .ownerUserID)
        }
        try c.encode(merchantName, forKey: .merchantName)
        try c.encode(title, forKey: .title)
        // Whole seconds: nothing reads it back as anything finer, and an integer cannot be mistaken for money.
        try c.encode(Int(createdAt.timeIntervalSince1970), forKey: .createdAt)
    }

    /// The record as bytes, for the Keychain.
    func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self)
    }

    static func decoded(from data: Data) throws -> PendingCheckout {
        try JSONDecoder().decode(PendingCheckout.self, from: data)
    }
}

// MARK: - The store

/// Why a pending-payment slot could not be read, written or removed. Carries the `OSStatus` and never
/// any part of the record.
public struct PendingStoreError: Error, Equatable, Sendable, CustomStringConvertible {
    public enum Operation: String, Sendable { case read, write, remove, list, obligation }
    public enum Kind: Equatable, Sendable {
        /// The store refused or could not be reached (a locked Keychain). The slot may still be there.
        case unavailable
        /// Something is stored that this build cannot read. It is neither "nothing" nor usable.
        case undecodable
    }

    public let operation: Operation
    public let kind: Kind
    public let status: Int32

    public init(operation: Operation, kind: Kind = .unavailable, status: Int32 = 0) {
        self.operation = operation
        self.kind = kind
        self.status = status
    }

    public var description: String { "PendingStoreError(\(operation.rawValue), \(kind), status \(status))" }
}

/// A removal that sign-out (or a change of user) owes, written down BEFORE it is attempted and taken back
/// when it is done. Without it a clear that failed (a locked Keychain) is forgotten by a restart, and the
/// next process shows the previous person's attempt to whoever holds the phone.
///
/// `cutoff` is when the obligation arose, in whole seconds: it removes only attempts made at or before
/// that moment, so an attempt a LATER session makes is never swept up by an obligation that was left over.
public struct CleanupObligation: Equatable, Codable, Sendable {
    public enum Scope: String, Codable, Sendable {
        /// Explicit sign-out: every attempt made while a session existed.
        case allSession
        /// A confirmed user: the attempts of other CONFIRMED users. An attempt whose owner was never
        /// confirmed is never removed by a sign-in: whoever signs in adopts it.
        case foreign
    }

    public let scope: Scope
    /// The confirmed user for `.foreign`; nil otherwise.
    public let userID: String?
    public let cutoff: Int

    public init(scope: Scope, userID: String? = nil, cutoff: Date) {
        self.scope = scope
        self.userID = userID
        self.cutoff = Int(cutoff.timeIntervalSince1970)
    }

    func removes(_ owner: AttemptOwner, createdAt: Date) -> Bool {
        guard Int(createdAt.timeIntervalSince1970) <= cutoff else { return false }
        switch (scope, owner) {
        case (_, .payer): return false
        case (.allSession, .session): return true
        case (.foreign, .session(let id?)): return id != userID
        case (.foreign, .session(nil)): return false
        }
    }
}

/// One entry of `PendingCheckoutStore.all()`.
public enum PendingSlot: Equatable, Sendable {
    case pending(PendingCheckout)
    /// A slot that exists but cannot be decoded; `slotID` is what `remove(slotID:)` takes.
    case unreadable(slotID: String)
}

/// Where an unsettled payment is remembered so that it outlives the screen, the scene and the
/// process. One slot per link code on the DEVICE: a cold start finds it before any session has
/// resolved, and opening another link never drops it.
///
/// Every call is synchronous and durable. `save` returning means the record is in secure storage, which
/// is what lets `CheckoutController` write it BEFORE the request leaves: if it cannot be written,
/// nothing is sent. There is no fallback to any other storage.
public protocol PendingCheckoutStore: Sendable {
    /// `nil` means nothing is stored. A throw is "could not find out" (`unavailable`) or "something is
    /// there I cannot read" (`undecodable`), and is never read as "nothing".
    func load(_ code: LinkCode) throws(PendingStoreError) -> PendingCheckout?

    /// Durably record the attempt in the slot of its link code, replacing what was there.
    func save(_ pending: PendingCheckout) throws(PendingStoreError)

    /// Forget the slot; removing a slot that is not there is not an error.
    func remove(_ code: LinkCode) throws(PendingStoreError)

    /// Forget a slot by its raw id, for an `unreadable` one.
    func remove(slotID: String) throws(PendingStoreError)

    /// Every slot on the device.
    func all() throws(PendingStoreError) -> [PendingSlot]

    /// The cleanup still owed, or nil. A throw is "could not find out", never "nothing owed".
    func loadObligation() throws(PendingStoreError) -> CleanupObligation?
    func saveObligation(_ obligation: CleanupObligation) throws(PendingStoreError)
    func clearObligation() throws(PendingStoreError)
}

/// A store in memory, for tests and previews. It does not persist anything, so it must never be what a
/// shipping build uses. Each failure can be switched on.
public final class InMemoryPendingCheckoutStore: PendingCheckoutStore, @unchecked Sendable {
    private let lock = NSLock()
    private var slots: [String: PendingSlot] = [:]
    private var failures: Set<PendingStoreError.Operation> = []
    private var failureKinds: [PendingStoreError.Operation: PendingStoreError.Kind] = [:]

    public init() {}

    /// Make every later `operation` throw, until `heal()`.
    public func fail(_ operation: PendingStoreError.Operation, as kind: PendingStoreError.Kind = .unavailable) {
        lock.lock()
        defer { lock.unlock() }
        failures.insert(operation)
        failureKinds[operation] = kind
    }

    public func heal() {
        lock.lock()
        defer { lock.unlock() }
        failures = []
        failureKinds = [:]
    }

    /// Put something unreadable in a slot, as a downgraded or corrupted Keychain item would be.
    public func plantUnreadable(_ code: LinkCode) {
        lock.lock()
        defer { lock.unlock() }
        slots[code.value] = .unreadable(slotID: code.value)
    }

    private func check(_ operation: PendingStoreError.Operation) throws(PendingStoreError) {
        if failures.contains(operation) {
            throw PendingStoreError(operation: operation, kind: failureKinds[operation] ?? .unavailable, status: -1)
        }
    }

    public func load(_ code: LinkCode) throws(PendingStoreError) -> PendingCheckout? {
        lock.lock()
        defer { lock.unlock() }
        try check(.read)
        switch slots[code.value] {
        case .pending(let pending): return pending
        case .unreadable: throw PendingStoreError(operation: .read, kind: .undecodable, status: -1)
        case nil: return nil
        }
    }

    public func save(_ pending: PendingCheckout) throws(PendingStoreError) {
        lock.lock()
        defer { lock.unlock() }
        try check(.write)
        slots[pending.request.code.value] = .pending(pending)
    }

    public func remove(_ code: LinkCode) throws(PendingStoreError) {
        lock.lock()
        defer { lock.unlock() }
        try check(.remove)
        slots[code.value] = nil
    }

    public func remove(slotID: String) throws(PendingStoreError) {
        lock.lock()
        defer { lock.unlock() }
        try check(.remove)
        slots[slotID] = nil
    }

    public func all() throws(PendingStoreError) -> [PendingSlot] {
        lock.lock()
        defer { lock.unlock() }
        try check(.list)
        return slots.keys.sorted().compactMap { slots[$0] }
    }

    private var storedObligation: CleanupObligation?

    public func loadObligation() throws(PendingStoreError) -> CleanupObligation? {
        lock.lock()
        defer { lock.unlock() }
        try check(.obligation)
        return storedObligation
    }

    public func saveObligation(_ obligation: CleanupObligation) throws(PendingStoreError) {
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
    public var obligation: CleanupObligation? {
        lock.lock()
        defer { lock.unlock() }
        return storedObligation
    }

    /// Everything stored, without going through the failure switches, for assertions.
    public var snapshot: [PendingCheckout] {
        lock.lock()
        defer { lock.unlock() }
        return slots.keys.sorted().compactMap { if case .pending(let p) = slots[$0] { p } else { nil } }
    }
}
