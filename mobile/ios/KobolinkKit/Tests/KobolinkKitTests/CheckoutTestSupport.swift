import Foundation
import KobolinkAPI

@testable import KobolinkKit

// Every name, email and reference below is invented for these tests.

enum CK {
    static let codeA = LinkCode("aBcDeFgH")!
    static let codeB = LinkCode("kLmNpQrS")!
    static let reference = "kbl_aBcDeFgHjK"
    static let otherReference = "kbl_mNpQrStUvW"

    static let payerName = "Ngozi Okafor"
    static let payerEmail = "ngozi@example.test"

    static let userOne = SignedInUser(id: "usr_one", email: "one@example.test", displayName: "One", role: .merchant)
    static let userTwo = SignedInUser(id: "usr_two", email: "two@example.test", displayName: "Two", role: .merchant)

    static func link(
        _ code: LinkCode = codeA,
        merchant: String = "Adebayo Stores",
        title: String = "Ankara Two-Piece Set",
        amountKobo: Int? = 1_850_000,
        expiresAt: Date? = nil
    ) -> CheckoutLink {
        CheckoutLink(code: code, merchantName: merchant, title: title, description: "Size 12", amountKobo: amountKobo, isReusable: false, expiresAt: expiresAt)
    }

    static func lookup(_ code: LinkCode = codeA, amountKobo: Int? = 1_850_000, availability: LinkAvailability = .payable) -> LinkLookup {
        LinkLookup(link: link(code, amountKobo: amountKobo), availability: availability)
    }

    static func started(
        _ code: LinkCode = codeA, amountKobo: Int = 1_850_000, reference: String = CK.reference
    ) -> StartedCheckout {
        StartedCheckout(reference: reference, code: code, amountKobo: amountKobo, createdAt: Date(timeIntervalSince1970: 1_790_000_000))
    }

    static func request(
        _ code: LinkCode = codeA, amountKobo: Int = 1_850_000, name: String = payerName, email: String = payerEmail
    ) -> InitializeRequest {
        InitializeRequest(code: code, amountKobo: amountKobo, payerName: name, payerEmail: email)
    }

    /// A refusal as `PaymentsService.errorResult` writes it: `moneyMoved: false` is always there.
    static func refusal(
        _ code: ApiErrorCode, status: Int, message: String = "Refused.", moneyMoved: Bool? = false,
        fields: [String: [String]] = [:], state: Components.Schemas.ApiError.statePayload? = nil
    ) -> APIError {
        .server(ServerError(status: status, code: code, message: message, fieldErrors: fields, moneyMoved: moneyMoved, linkState: state))
    }

    static let linkNotPayable = refusal(.link_not_payable, status: 409, message: "This link cannot be paid right now.")
    static let amountMismatch = refusal(.amount_mismatch, status: 422, message: "That amount does not match this link.")
    static let notFound = refusal(.not_found, status: 404, message: "No link with that code.")
    static let offline = APIError.unreachable(.notConnectedToInternet)

    /// A checkout already persisted by an earlier run: what a cold start finds.
    static func pending(
        _ code: LinkCode = codeA, key: String = "00000000-0000-4000-8000-00000000000A", owner: AttemptOwner = .payer,
        reference: String? = nil, amountKobo: Int = 1_850_000, settled: PaymentResult? = nil
    ) -> PendingCheckout {
        PendingCheckout(
            key: key, request: request(code, amountKobo: amountKobo), reference: reference, confirmedAmountKobo: reference == nil ? nil : amountKobo,
            settled: settled,
            owner: owner, merchantName: "Adebayo Stores", title: "Ankara Two-Piece Set", createdAt: Date(timeIntervalSince1970: 1_790_000_000))
    }

    /// A `verify` answer as the server writes it: `moneyMoved` is `true` exactly when the payment succeeded.
    static func payment(
        _ status: VerifiedPayment.Status = .success, reference: String = CK.reference, code: LinkCode = codeA,
        amountKobo: Int = 1_850_000, reason: String? = nil, moneyMoved: Bool? = nil
    ) -> VerifiedPayment {
        VerifiedPayment(
            reference: reference, code: code, amountKobo: amountKobo, status: status,
            moneyMoved: moneyMoved ?? (status == .success), failureReason: reason)
    }

    static let paid = payment(.success)
    static let declined = payment(.failed, reason: "Card declined by the simulated gateway.")
    static let stillPending = payment(.pending)
}

extension AttemptPhase {
    /// A started payment whose `verify` was asked and could not be completed: what the screen shows when a test
    /// scripts `initialize` and nothing for `verify` (the fake then answers "no connection").
    static let startedUnverified = AttemptPhase.unconfirmed(.noConnection)
}

/// A scripted `CheckoutServing`. Replies are consumed first in first out; a call with nothing queued
/// fails as "offline" so a test that forgot to script one fails loudly rather than hanging.
final class FakeCheckout: CheckoutServing, @unchecked Sendable {
    struct Reply<T: Sendable>: Sendable {
        let result: Result<T, APIError>
        let gate: Gate?
    }

    struct Send: Equatable {
        let request: InitializeRequest
        let key: String
    }

    struct Verify: Equatable {
        let reference: String
        let key: String
    }

    private let lock = NSLock()
    private var lookupQueue: [Reply<LinkLookup>] = []
    private var initializeQueue: [Reply<StartedCheckout>] = []
    private var verifyQueue: [Reply<VerifiedPayment>] = []
    private var lookupLog: [LinkCode] = []
    private var sendLog: [Send] = []
    private var verifyLog: [Verify] = []
    /// Called inside `initializeCheckout`, before it answers: what the store held when the request "left".
    var onSend: (@Sendable (Send) -> Void)?

    func queueLookup(_ result: Result<LinkLookup, APIError>, gate: Gate? = nil) {
        lock.lock()
        lookupQueue.append(Reply(result: result, gate: gate))
        lock.unlock()
    }

    func queueInitialize(_ result: Result<StartedCheckout, APIError>, gate: Gate? = nil) {
        lock.lock()
        initializeQueue.append(Reply(result: result, gate: gate))
        lock.unlock()
    }

    func queueVerify(_ result: Result<VerifiedPayment, APIError>, gate: Gate? = nil) {
        lock.lock()
        verifyQueue.append(Reply(result: result, gate: gate))
        lock.unlock()
    }

    var verifies: [Verify] {
        lock.lock()
        defer { lock.unlock() }
        return verifyLog
    }

    var lookups: [LinkCode] {
        lock.lock()
        defer { lock.unlock() }
        return lookupLog
    }

    var sends: [Send] {
        lock.lock()
        defer { lock.unlock() }
        return sendLog
    }

    func lookupLink(code: LinkCode) async throws(APIError) -> LinkLookup {
        let reply: Reply<LinkLookup>? = {
            lock.lock()
            defer { lock.unlock() }
            lookupLog.append(code)
            return lookupQueue.isEmpty ? nil : lookupQueue.removeFirst()
        }()
        guard let reply else { throw CK.offline }
        await reply.gate?.wait()
        return try reply.result.get()
    }

    func initializeCheckout(_ request: InitializeRequest, idempotencyKey: String) async throws(APIError) -> StartedCheckout {
        let send = Send(request: request, key: idempotencyKey)
        let reply: Reply<StartedCheckout>? = {
            lock.lock()
            defer { lock.unlock() }
            sendLog.append(send)
            return initializeQueue.isEmpty ? nil : initializeQueue.removeFirst()
        }()
        onSend?(send)
        guard let reply else { throw CK.offline }
        await reply.gate?.wait()
        return try reply.result.get()
    }

    func verifyCheckout(reference: String, idempotencyKey: String) async throws(APIError) -> VerifiedPayment {
        let reply: Reply<VerifiedPayment>? = {
            lock.lock()
            defer { lock.unlock() }
            verifyLog.append(Verify(reference: reference, key: idempotencyKey))
            return verifyQueue.isEmpty ? nil : verifyQueue.removeFirst()
        }()
        guard let reply else { throw CK.offline }
        await reply.gate?.wait()
        return try reply.result.get()
    }
}

/// Stands in for the wait between automatic re-asks. Each wait is recorded and held until the test releases it,
/// so a test decides exactly when a re-ask is due, and a cancelled wait ends instead of firing.
final class Sleeper: @unchecked Sendable {
    private let lock = NSLock()
    private var waits: [Duration] = []
    private var released = 0
    private var ended = 0

    /// Every wait asked for, in order.
    var requested: [Duration] {
        lock.lock()
        defer { lock.unlock() }
        return waits
    }

    /// How many waits ended because their task was cancelled (not because the test released them).
    var cancelled: Int {
        lock.lock()
        defer { lock.unlock() }
        return ended
    }

    /// Let the next `count` waits (in the order they were asked) finish.
    func release(_ count: Int = 1) {
        lock.lock()
        released += count
        lock.unlock()
    }

    func sleep(_ duration: Duration) async throws {
        let ticket: Int = {
            lock.lock()
            defer { lock.unlock() }
            waits.append(duration)
            return waits.count
        }()
        do {
            // A wait nobody releases or cancels (a test that ended first) gives up after about six seconds.
            for _ in 0..<3000 {
                try Task.checkCancellation()
                let go: Bool = {
                    lock.lock()
                    defer { lock.unlock() }
                    return released >= ticket
                }()
                if go { return }
                try await Task.sleep(for: .milliseconds(2))
            }
            throw CancellationError()
        } catch {
            noteEnded()
            throw error
        }
    }

    private func noteEnded() {
        lock.lock()
        ended += 1
        lock.unlock()
    }
}

/// Keys that are valid but recognisable: `key-1`, `key-2`, ...
final class KeyMaker: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private let digit: Int

    /// `digit` 1 for initialize keys, 2 for verify keys, so the two kinds can never be mistaken for each other.
    init(digit: Int = 1) { self.digit = digit }

    func make() -> String {
        lock.lock()
        defer { lock.unlock() }
        count += 1
        return String(format: "\(digit)\(digit)\(digit)\(digit)\(digit)\(digit)\(digit)\(digit)-\(digit)\(digit)\(digit)\(digit)-4\(digit)\(digit)\(digit)-8\(digit)\(digit)\(digit)-%012d", count)
    }

    var made: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
}

@MainActor
struct CheckoutRig {
    let service = FakeCheckout()
    let store: InMemoryPendingCheckoutStore
    /// The keys `initialize` is sent under. A verify never draws from here: the key a payment was initialized
    /// under is never minted again, so `keys.made` stays 1 however often verify is asked.
    let keys = KeyMaker()
    let verifyKeys = KeyMaker(digit: 2)
    let sleeper = Sleeper()
    let controller: CheckoutController
    /// What `ownerNow` answers; a test changes it to model the session moving on.
    let owner: OwnerBox
    /// The wall clock the controller sees; a test moves it, backwards too.
    let clock = ClockBox()

    final class ClockBox: @unchecked Sendable {
        private let lock = NSLock()
        private var seconds = 1_790_000_000
        var value: Date {
            get { lock.lock(); defer { lock.unlock() }; return Date(timeIntervalSince1970: TimeInterval(seconds)) }
            set { lock.lock(); defer { lock.unlock() }; seconds = Int(newValue.timeIntervalSince1970) }
        }
    }

    final class OwnerBox: @unchecked Sendable {
        var value: AttemptOwner = .payer
    }

    init(store: InMemoryPendingCheckoutStore = InMemoryPendingCheckoutStore(), owner: AttemptOwner = .payer) {
        self.store = store
        let box = OwnerBox()
        box.value = owner
        self.owner = box
        let keys = self.keys
        let verifyKeys = self.verifyKeys
        let clock = self.clock
        let sleeper = self.sleeper
        controller = CheckoutController(
            service: service,
            store: store,
            ownerNow: { box.value },
            makeKey: { keys.make() },
            makeVerifyKey: { verifyKeys.make() },
            now: { clock.value },
            verifyDelays: [.seconds(2), .seconds(4), .seconds(8)],
            sleep: { try await sleeper.sleep($0) }
        )
    }

    /// A new process over the same storage: what a cold start sees.
    func relaunched(owner: AttemptOwner = .payer) -> CheckoutRig {
        CheckoutRig(store: store, owner: owner)
    }

    func fillForm(name: String = CK.payerName, email: String = CK.payerEmail, amount: String = "") {
        controller.form.name = name
        controller.form.email = email
        controller.form.amountText = amount
    }

    /// Open `code`, answer its lookup, and wait for the form.
    func openPayable(_ code: LinkCode = CK.codeA, amountKobo: Int? = 1_850_000) async {
        service.queueLookup(.success(CK.lookup(code, amountKobo: amountKobo)))
        controller.open(code)
        _ = await waitUntil { if case .link = controller.screen { true } else { false } }
    }

    var linkScreen: LinkScreen? {
        if case .link(let screen) = controller.screen { screen } else { nil }
    }

    var attemptScreen: AttemptScreen? {
        if case .attempt(let screen) = controller.screen { screen } else { nil }
    }

    var resultScreen: ResultScreen? {
        if case .result(let screen) = controller.screen { screen } else { nil }
    }

    /// Pay with the form filled in, and wait until the screen has a reference (initialize answered).
    func payAndStart(
        reply: StartedCheckout = CK.started(), verify: Result<VerifiedPayment, APIError>? = nil, gate: Gate? = nil
    ) async {
        fillForm()
        service.queueInitialize(.success(reply))
        if let verify { service.queueVerify(verify, gate: gate) }
        controller.pay()
        _ = await waitUntil { attemptScreen?.reference != nil || resultScreen != nil }
    }

    func settle() async {
        // Let any task that was released run to completion.
        try? await Task.sleep(for: .milliseconds(30))
    }
}
