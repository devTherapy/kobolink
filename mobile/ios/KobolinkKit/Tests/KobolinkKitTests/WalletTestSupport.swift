import Foundation
import KobolinkAPI

@testable import KobolinkKit

// Every name, number and amount below is invented for these tests.

enum WK {
    static let phoneA = "+2348031234567"
    static let phoneB = "+2349012345678"
    static let displayA = "0803 123 4567"

    static let userOne = SignedInUser(id: "usr_one", email: "one@example.test", displayName: "One", role: .customer)
    static let userTwo = SignedInUser(id: "usr_two", email: "two@example.test", displayName: "Two", role: .customer)

    static let at = Date(timeIntervalSince1970: 1_790_000_000)

    static func instruction(
        phone: String = phoneA, amountKobo: Int = 150_000, note: String? = nil
    ) -> TransferInstruction {
        TransferInstruction(toPhone: phone, amountKobo: amountKobo, note: note)
    }

    static func balance(_ kobo: Int = 5_000_000, asOf: Date = at, account: String = "acc_one") -> WalletBalance {
        WalletBalance(accountId: account, balanceKobo: kobo, asOf: asOf)
    }

    static func activity(
        _ id: String = "pst_1", amountKobo: Int = -150_000, counterparty: String? = "Ada Obi", note: String? = nil,
        kind: ActivityKind = .transfer, at: Date = WK.at
    ) -> WalletActivity {
        WalletActivity(id: id, kind: kind, amountKobo: amountKobo, counterparty: counterparty, note: note, createdAt: at)
    }

    /// The reply to a transfer of `instruction`: the posting and the sender's wallet after it.
    static func receipt(
        for instruction: TransferInstruction = instruction(), balanceKobo: Int = 4_850_000, asOf: Date = at, id: String = "pst_1"
    ) -> TransferReceipt {
        TransferReceipt(
            activity: activity(id, amountKobo: -instruction.amountKobo, note: instruction.note, at: asOf),
            wallet: balance(balanceKobo, asOf: asOf))
    }

    static func attempt(
        key: String = "11111111-1111-4111-8111-000000000001", user: SignedInUser = userOne, instruction: TransferInstruction = instruction(),
        payeeName: String? = nil
    ) -> TransferAttempt {
        TransferAttempt(key: key, userID: user.id, instruction: instruction, payeeName: payeeName, createdAt: at)
    }

    /// A refusal as `WalletService.errorResult` writes it: `moneyMoved: false` is always there.
    static func refusal(
        _ code: ApiErrorCode, status: Int, message: String = "Refused.", moneyMoved: Bool? = false,
        fields: [String: [String]] = [:], retryAfter: Int? = nil
    ) -> APIError {
        .server(ServerError(status: status, code: code, message: message, fieldErrors: fields, moneyMoved: moneyMoved, retryAfterSeconds: retryAfter))
    }

    static let insufficient = refusal(.insufficient_funds, status: 422, message: "Insufficient wallet balance.")
    static let noWallet = refusal(.not_found, status: 404, message: "No wallet is registered to that phone number.")
    static let ownNumber = refusal(
        .validation_failed, status: 400, message: "You cannot transfer money to yourself.",
        fields: ["toPhone": ["cannot transfer to yourself"]])
    /// What `ZodValidationPipe` answers: no `moneyMoved`, because it ran before anything was recorded.
    static let badBody = refusal(
        .validation_failed, status: 400, message: "Validation failed.", moneyMoved: nil,
        fields: ["amountKobo": ["Too small"]])
    static let unauthenticated = refusal(.unauthenticated, status: 401, message: "Sign in to continue.", moneyMoved: nil)
    static let mismatch = refusal(.idempotency_mismatch, status: 422, message: "This Idempotency-Key was already used with a different request.")
    static let offline = APIError.unreachable(.notConnectedToInternet)
}

/// A scripted `WalletServing`. Replies are consumed first in first out; a call with nothing queued fails as
/// "offline" so a test that forgot to script one fails loudly rather than hanging.
final class FakeWallet: WalletServing, @unchecked Sendable {
    struct Reply<T: Sendable>: Sendable {
        let result: Result<T, APIError>
        let gate: Gate?
    }

    struct Send: Equatable {
        let instruction: TransferInstruction
        let key: String
    }

    private let lock = NSLock()
    private var walletQueue: [Reply<WalletBalance>] = []
    private var activityQueue: [Reply<ActivityPage>] = []
    private var transferQueue: [Reply<TransferReceipt>] = []
    private var sendLog: [Send] = []
    private var activityCursors: [String?] = []
    private var walletCount = 0
    /// Called inside `transfer`, before it answers: what the store held when the request "left".
    var onSend: (@Sendable (Send) -> Void)?

    func queueWallet(_ result: Result<WalletBalance, APIError>, gate: Gate? = nil) {
        lock.lock()
        walletQueue.append(Reply(result: result, gate: gate))
        lock.unlock()
    }

    func queueActivity(_ result: Result<ActivityPage, APIError>, gate: Gate? = nil) {
        lock.lock()
        activityQueue.append(Reply(result: result, gate: gate))
        lock.unlock()
    }

    func queueTransfer(_ result: Result<TransferReceipt, APIError>, gate: Gate? = nil) {
        lock.lock()
        transferQueue.append(Reply(result: result, gate: gate))
        lock.unlock()
    }

    var sends: [Send] {
        lock.lock()
        defer { lock.unlock() }
        return sendLog
    }

    var cursors: [String?] {
        lock.lock()
        defer { lock.unlock() }
        return activityCursors
    }

    var walletReads: Int {
        lock.lock()
        defer { lock.unlock() }
        return walletCount
    }

    func wallet() async throws(APIError) -> WalletBalance {
        let reply: Reply<WalletBalance>? = {
            lock.lock()
            defer { lock.unlock() }
            walletCount += 1
            return walletQueue.isEmpty ? nil : walletQueue.removeFirst()
        }()
        guard let reply else { throw WK.offline }
        await reply.gate?.wait()
        return try reply.result.get()
    }

    func activity(cursor: String?) async throws(APIError) -> ActivityPage {
        let reply: Reply<ActivityPage>? = {
            lock.lock()
            defer { lock.unlock() }
            activityCursors.append(cursor)
            return activityQueue.isEmpty ? nil : activityQueue.removeFirst()
        }()
        guard let reply else { throw WK.offline }
        await reply.gate?.wait()
        return try reply.result.get()
    }

    func transfer(_ instruction: TransferInstruction, idempotencyKey: String) async throws(APIError) -> TransferReceipt {
        let send = Send(instruction: instruction, key: idempotencyKey)
        let reply: Reply<TransferReceipt>? = {
            lock.lock()
            defer { lock.unlock() }
            sendLog.append(send)
            return transferQueue.isEmpty ? nil : transferQueue.removeFirst()
        }()
        onSend?(send)
        guard let reply else { throw WK.offline }
        await reply.gate?.wait()
        return try reply.result.get()
    }
}

@MainActor
final class FakeCamera: CameraAccess {
    var hasCamera = true
    var authorization: CameraAuthorization = .notDetermined
    /// What the system prompt will decide.
    var grantsAccess = true
    private(set) var requests = 0

    func requestAccess() async -> Bool {
        requests += 1
        authorization = grantsAccess ? .authorized : .denied
        return grantsAccess
    }
}

@MainActor
struct WalletRig {
    let service = FakeWallet()
    let store: InMemoryPendingTransferStore
    let keys: KeyMaker
    let camera = FakeCamera()
    let wallet: WalletController
    private let now: @Sendable () -> Date

    var send: SendController { wallet.send }
    var home: WalletHomeController { wallet.home }

    init(
        store: InMemoryPendingTransferStore = InMemoryPendingTransferStore(), user: SignedInUser? = WK.userOne,
        now: @escaping @Sendable () -> Date = { Date() }, keys: KeyMaker = KeyMaker()
    ) {
        self.store = store
        self.now = now
        self.keys = keys
        wallet = WalletController(service: service, store: store, camera: camera, makeKey: { [keys] in keys.make() }, now: now)
        if let user { wallet.sessionDidChange(.resolved(user)) }
    }

    /// A new process over the same storage: what a cold start sees.
    func relaunched(user: SignedInUser? = WK.userOne) -> WalletRig {
        WalletRig(store: store, user: user, now: now)
    }

    func fillForm(phone: String = "0803 123 4567", amount: String = "1500", note: String = "") {
        send.form.setPhone(phone)
        send.form.amountText = amount
        send.form.note = note
    }

    /// Open Send, fill the form, review it, and tap Send.
    func startPayment(phone: String = "0803 123 4567", amount: String = "1500", note: String = "") {
        wallet.openSend()
        fillForm(phone: phone, amount: amount, note: note)
        send.review()
        send.confirm()
    }

    func settle() async {
        try? await Task.sleep(for: .milliseconds(30))
    }

    var failure: TransferFailure? {
        if case .failed(_, let failure) = send.screen { failure } else { nil }
    }

    var attemptOnScreen: TransferAttempt? {
        switch send.screen {
        case .sending(let attempt, _), .failed(let attempt, _), .sent(let attempt, _, _): attempt
        default: nil
        }
    }

    var isSent: Bool {
        if case .sent = send.screen { true } else { false }
    }
}
