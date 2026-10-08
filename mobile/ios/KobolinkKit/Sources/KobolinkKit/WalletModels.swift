import Foundation
import KobolinkAPI

// The wallet as the app sees it. Mapped once from the generated models so no screen touches a generated type
// (their payload types are named after where the schema happens to be inlined), and so a reply that breaks the
// contract is an unreadable reply, never a half-trusted one.
//
// Money is `Int` kobo end to end. A balance is SIGNED (a funding account is always negative, a wallet never is);
// an activity amount is signed from this wallet's point of view: negative is money out.

/// `GET /api/wallet`, or the sender's wallet inside a transfer reply. The server derives it from the ledger;
/// the app never computes a balance, it only shows the last one it was told, together with when that was
/// (`asOf`), so an older answer is never presented as the current one.
public struct WalletBalance: Equatable, Sendable {
    public let accountId: String
    public let balanceKobo: Int
    public let asOf: Date

    public init(accountId: String, balanceKobo: Int, asOf: Date) {
        self.accountId = accountId
        self.balanceKobo = balanceKobo
        self.asOf = asOf
    }
}

public enum ActivityKind: Equatable, Sendable {
    case transfer
    case topUp
    case linkPayment
}

/// One row of "Recent activity".
public struct WalletActivity: Equatable, Identifiable, Sendable {
    public let id: String
    public let kind: ActivityKind
    /// Negative is money out of this wallet.
    public let amountKobo: Int
    /// The other party's display name, as the server has it. `nil` for a top-up.
    public let counterparty: String?
    public let note: String?
    public let createdAt: Date

    public init(id: String, kind: ActivityKind, amountKobo: Int, counterparty: String?, note: String?, createdAt: Date) {
        self.id = id
        self.kind = kind
        self.amountKobo = amountKobo
        self.counterparty = counterparty
        self.note = note
        self.createdAt = createdAt
    }
}

public struct ActivityPage: Equatable, Sendable {
    public let items: [WalletActivity]
    /// `nil` on the last page.
    public let nextCursor: String?

    public init(items: [WalletActivity], nextCursor: String?) {
        self.items = items
        self.nextCursor = nextCursor
    }
}

/// `201` from `POST /api/wallet/transfer`: the posted transfer and the sender's wallet after it.
///
/// A REPLAY of a key returns the ORIGINAL reply, with the balance and `asOf` of the moment it first posted.
/// So `wallet.asOf` can be hours old, and a receipt is never a statement about the balance right now.
public struct TransferReceipt: Equatable, Sendable {
    public let activity: WalletActivity
    public let wallet: WalletBalance

    public init(activity: WalletActivity, wallet: WalletBalance) {
        self.activity = activity
        self.wallet = wallet
    }
}

/// The exact body of `POST /api/wallet/transfer`, and so what one idempotency key is bound to. Equality is how
/// "the same request" is decided: a key is only ever reused for an equal instruction.
///
/// `note` is OPTIONAL, never `nil`-on-the-wire: contracts' `TransferRequestSchema` says `note: string().optional()`,
/// not nullable, so a note-less payment OMITS the key (Android's M5 sent `"note": null` and every note-less send
/// would have been refused). `TransferWireTests` serialises through the generated client to prove it.
public struct TransferInstruction: Equatable, Hashable, Sendable {
    /// E.164, `+234XXXXXXXXXX`.
    public let toPhone: String
    public let amountKobo: Int
    /// Trimmed, 1 to 140 characters, or `nil`. Never an empty string.
    public let note: String?

    public init(toPhone: String, amountKobo: Int, note: String?) {
        self.toPhone = toPhone
        self.amountKobo = amountKobo
        self.note = note
    }

    /// The longest note the contract accepts (`.max(140)`, counted as the schema counts).
    public static let noteMaxLength = 140
}

/// The three wallet calls the screens make. `KobolinkAPIClient` is the real one; tests supply a script.
///
/// There is deliberately nothing here that writes a ledger row: the only money-moving call asks the server to
/// post, and the server decides (CLAUDE.md: clients never write ledger rows). All three carry the session token
/// (`AuthMiddleware.securedOperations`).
public protocol WalletServing: Sendable {
    /// `GET /api/wallet`.
    func wallet() async throws(APIError) -> WalletBalance

    /// `GET /api/wallet/transactions`, newest first. `cursor` is the previous page's `nextCursor`.
    func activity(cursor: String?) async throws(APIError) -> ActivityPage

    /// `POST /api/wallet/transfer` under `idempotencyKey`. Exactly one request leaves: nothing retries. The caller
    /// holds the key for the whole life of one payment: a replay of the same key and body returns the stored answer,
    /// never a second posting, and the same key with a different body is `idempotency_mismatch`.
    func transfer(_ instruction: TransferInstruction, idempotencyKey: String) async throws(APIError) -> TransferReceipt
}

// MARK: - Mapping from the generated models

private let maximumNoteLength = TransferInstruction.noteMaxLength

private func isOpaqueID(_ text: String) -> Bool {
    let bytes = Array(text.utf8)
    return (1...64).contains(bytes.count)
        && bytes.allSatisfy {
            (0x30...0x39).contains($0) || (0x41...0x5A).contains($0) || (0x61...0x7A).contains($0) || $0 == 0x5F || $0 == 0x2D
        }
}

extension WalletBalance {
    /// `currency` is not checked here: the generated model decodes it as a one-case enum (`NGN`), so a reply in any
    /// other currency never gets this far, it is an unreadable reply.
    init?(validating accountId: String, balanceKobo: Int, asOf: Date) {
        guard isOpaqueID(accountId) else { return nil }
        self.init(accountId: accountId, balanceKobo: balanceKobo, asOf: asOf)
    }

    init?(_ wire: Components.Schemas.Wallet) {
        self.init(validating: wire.accountId, balanceKobo: wire.balanceKobo, asOf: wire.asOf)
    }

    init?(_ wire: Components.Schemas.TransferResponse.walletPayload) {
        self.init(validating: wire.accountId, balanceKobo: wire.balanceKobo, asOf: wire.asOf)
    }
}

extension WalletActivity {
    /// The same row is inlined under three names in the document; they all land here.
    init?(
        postingId: String, kind: String, amountKobo: Int, counterparty: String?, note: String?, createdAt: Date
    ) {
        guard isOpaqueID(postingId) else { return nil }
        let mapped: ActivityKind
        switch kind {
        case "transfer": mapped = .transfer
        case "topup": mapped = .topUp
        case "link_payment": mapped = .linkPayment
        default: return nil
        }
        self.init(id: postingId, kind: mapped, amountKobo: amountKobo, counterparty: counterparty, note: note, createdAt: createdAt)
    }

    init?(_ wire: Components.Schemas.WalletTransactionListResponse.itemsPayloadPayload) {
        self.init(
            postingId: wire.postingId, kind: wire.kind.rawValue, amountKobo: wire.amountKobo,
            counterparty: wire.counterparty, note: wire.note, createdAt: wire.createdAt)
    }

    init?(_ wire: Components.Schemas.TransferResponse.transactionPayload) {
        self.init(
            postingId: wire.postingId, kind: wire.kind.rawValue, amountKobo: wire.amountKobo,
            counterparty: wire.counterparty, note: wire.note, createdAt: wire.createdAt)
    }
}

extension TransferReceipt {
    init?(_ wire: Components.Schemas.TransferResponse) {
        guard let activity = WalletActivity(wire.transaction), let wallet = WalletBalance(wire.wallet) else { return nil }
        self.init(activity: activity, wallet: wallet)
    }
}

extension ActivityPage {
    init?(_ wire: Components.Schemas.WalletTransactionListResponse) {
        var items: [WalletActivity] = []
        for item in wire.items {
            guard let mapped = WalletActivity(item) else { return nil }
            items.append(mapped)
        }
        self.init(items: items, nextCursor: wire.nextCursor)
    }
}

/// What the form is allowed to send, as the contract states it.
extension TransferInstruction {
    /// A note as the schema reads it: `.trim()`, then at most 140 characters.
    static func cleanNote(_ raw: String) -> (note: String?, tooLong: Bool) {
        let trimmed = JavaScriptText.trimmed(raw)
        if trimmed.isEmpty { return (nil, false) }
        return (trimmed, JavaScriptText.length(trimmed) > maximumNoteLength)
    }
}
