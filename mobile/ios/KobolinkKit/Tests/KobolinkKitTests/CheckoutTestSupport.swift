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
        reference: String? = nil, amountKobo: Int = 1_850_000
    ) -> PendingCheckout {
        PendingCheckout(
            key: key, request: request(code, amountKobo: amountKobo), reference: reference, confirmedAmountKobo: reference == nil ? nil : amountKobo,
            owner: owner, merchantName: "Adebayo Stores", title: "Ankara Two-Piece Set", createdAt: Date(timeIntervalSince1970: 1_790_000_000))
    }
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

    private let lock = NSLock()
    private var lookupQueue: [Reply<LinkLookup>] = []
    private var initializeQueue: [Reply<StartedCheckout>] = []
    private var lookupLog: [LinkCode] = []
    private var sendLog: [Send] = []
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
}

/// Keys that are valid but recognisable: `key-1`, `key-2`, ...
final class KeyMaker: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func make() -> String {
        lock.lock()
        defer { lock.unlock() }
        count += 1
        return String(format: "11111111-1111-4111-8111-%012d", count)
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
    let keys = KeyMaker()
    let controller: CheckoutController
    /// What `ownerNow` answers; a test changes it to model the session moving on.
    let owner: OwnerBox

    final class OwnerBox: @unchecked Sendable {
        var value: AttemptOwner = .payer
    }

    init(store: InMemoryPendingCheckoutStore = InMemoryPendingCheckoutStore(), owner: AttemptOwner = .payer) {
        self.store = store
        let box = OwnerBox()
        box.value = owner
        self.owner = box
        let keys = self.keys
        controller = CheckoutController(
            service: service,
            store: store,
            ownerNow: { box.value },
            makeKey: { keys.make() },
            now: { Date(timeIntervalSince1970: 1_790_000_000) }
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

    func settle() async {
        // Let any task that was released run to completion.
        try? await Task.sleep(for: .milliseconds(30))
    }
}
