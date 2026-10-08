import Foundation
import Observation

/// The text fields of the payer form, and the error beside each. Held by the controller (not by the
/// view) so that signing out can empty them synchronously, whatever the view is doing.
@MainActor
@Observable
public final class CheckoutForm {
    public var name = ""
    public var email = ""
    /// What was typed into the amount field; used only for an open-amount link.
    public var amountText = ""
    public internal(set) var errors: [PayerField: String] = [:]
    /// Bumped by every reset. The view gives its fields this as their identity, so a field that is
    /// focused (and so keeps showing what it was last given) is rebuilt instead of trusted to follow
    /// the binding.
    public internal(set) var resetCount = 0

    public init() {}

    public var isEmpty: Bool { name.isEmpty && email.isEmpty && amountText.isEmpty }

    /// The person edited `field`: its error no longer describes what is typed.
    public func edited(_ field: PayerField) {
        errors[field] = nil
    }

    /// The person left `field`: say what is wrong with it now, rather than when they press Pay.
    public func left(_ field: PayerField) {
        let text: String
        switch field {
        case .amount: text = amountText
        case .name: text = name
        case .email: text = email
        }
        errors[field] = PayerValidation.problem(with: field, text: text)
    }

    func reset() {
        name = ""
        email = ""
        amountText = ""
        errors = [:]
        resetCount += 1
    }
}

/// What a `POST /api/checkout/initialize` answer lets the app conclude about the attempt it belongs to.
///
/// This is the single place that decides whether an answer settles an attempt, because that decision
/// is where a double payment would come from (Android's wallet was blocked three times on it): a
/// refusal that applies only to the REPLAY says nothing about whether the first send posted.
enum SendVerdict: Equatable {
    /// 201 with a reference. The attempt is kept: `verify` settles it.
    case started(StartedCheckout)
    /// A refusal the idempotency layer stores under the key and the server says moved no money:
    /// `not_found`, `link_not_payable`, `amount_mismatch` (the only outcomes `decideInitialize` computes
    /// inside `IdempotencyService.run`). It is THE answer for this key, whether this was the first send
    /// or a replay, and it would be replayed to every identical retry, so the attempt ends.
    case settled(ServerError)
    /// `validation_failed` on the very first send ever of this attempt. The controller validates the
    /// body before it touches the idempotency layer or the database, so nothing was recorded. On a
    /// RETRY the same answer proves nothing, because the first send is not accounted for.
    case rejected(ServerError)
    /// Anything else: the outcome is unknown, the key and the exact request are kept.
    case unsettled(Unsettled)

    private static let settledStatus: [ApiErrorCode: Int] = [
        .not_found: 404, .link_not_payable: 409, .amount_mismatch: 422,
    ]

    static func of(
        _ result: Result<StartedCheckout, APIError>,
        request: InitializeRequest,
        firstEverSend: Bool
    ) -> SendVerdict {
        switch result {
        case .success(let started):
            // A reply about some other payment is not an answer to this one.
            guard started.code == request.code, started.amountKobo == request.amountKobo else {
                return .unsettled(.unreadable)
            }
            return .started(started)

        case .failure(.server(let error)):
            if error.moneyMoved == false, settledStatus[error.code] == error.status {
                return .settled(error)
            }
            if firstEverSend, error.code == .validation_failed, error.status == 400, error.moneyMoved != true {
                return .rejected(error)
            }
            switch error.code {
            case .rate_limited:
                return .unsettled(.rateLimited(retryAfterSeconds: error.retryAfterSeconds))
            case ._internal:
                return .unsettled(.serverProblem)
            default:
                return error.status >= 500 ? .unsettled(.serverProblem) : .unsettled(.refused(message: error.message))
            }

        case .failure(.unexpectedResponse(let status)):
            return .unsettled(status >= 500 ? .serverProblem : .unreadable)
        case .failure(.undecodableResponse):
            return .unsettled(.unreadable)
        case .failure(.unreachable), .failure(.cancelled):
            return .unsettled(.noConnection)
        }
    }
}

/// What a `POST /api/checkout/verify` answer lets the app conclude about the payment it asked after.
///
/// `verify` is the ONLY thing that may settle a started payment, so this is the single place that decides which
/// answers do. The rule is the one `SendVerdict` follows for `initialize`, applied to the server's own words:
///
/// - `decided` needs the server to have SAID so: a `200` payment that is `success` (with `moneyMoved: true`) or
///   `failed` (with `moneyMoved: false`) and that is about THIS reference, link and amount; or a `404 not_found` /
///   `409 link_not_payable` that says `moneyMoved: false` (the same triples the idempotency layer stores under the key
///   for `initialize`, so they are the answer for the reference, not for one replay).
/// - Everything else (a 5xx, a 429, a dropped connection, a redirect, a 401, an unreadable body, a validation error, a
///   reply about some other payment) decides NOTHING: the slot stays, and the copy never says no money moved. A
///   refusal that applies to a request and not to the checkout cannot prove what happened to the checkout.
enum VerifyVerdict: Equatable {
    case decided(PaymentResult)
    /// The server says the payment is not decided yet (`status: pending`, which by contract means `moneyMoved: false`).
    case notDecided
    case unconfirmed(Unconfirmed)

    /// The reasons `PaymentsService.notPayableReason` writes into `failureReason` when the link could not take the
    /// payment by the time it was decided. The contract carries them as free text (a finding for the contract owner:
    /// a structured reason would not depend on these sentences), so only an exact match is trusted; any other
    /// `failureReason` is shown as the server's own words.
    static func linkProblem(forReason reason: String?) -> PaymentResult? {
        switch reason?.trimmingCharacters(in: .whitespacesAndNewlines) {
        case "Link is disabled": .linkDisabled
        case "Link has expired": .linkExpired
        case "Link is already paid": .linkAlreadyPaid
        default: nil
        }
    }

    static func of(
        _ result: Result<VerifiedPayment, APIError>,
        reference: String,
        code: LinkCode,
        amountKobo: Int
    ) -> VerifyVerdict {
        switch result {
        case .success(let payment):
            // A reply about some other payment is not an answer to this one.
            guard payment.reference == reference, payment.code == code, payment.amountKobo == amountKobo else {
                return .unconfirmed(.unreadable)
            }
            switch payment.status {
            case .success:
                return payment.moneyMoved ? .decided(.paid) : .unconfirmed(.unreadable)
            case .failed:
                // A failure that says money moved is not a failure this app knows how to describe.
                guard !payment.moneyMoved else { return .unconfirmed(.unreadable) }
                return .decided(linkProblem(forReason: payment.failureReason) ?? .declined(reason: payment.failureReason))
            case .pending:
                return payment.moneyMoved ? .unconfirmed(.unreadable) : .notDecided
            }

        case .failure(.server(let error)):
            if error.moneyMoved == false {
                if error.code == .not_found, error.status == 404 { return .decided(.checkoutNotFound) }
                if error.code == .link_not_payable, error.status == 409, let state = error.linkState {
                    switch state {
                    case .disabled: return .decided(.linkDisabled)
                    case .expired: return .decided(.linkExpired)
                    case .already_hyphen_paid: return .decided(.linkAlreadyPaid)
                    case .payable: break
                    }
                }
            }
            if error.status == 401 || error.status == 403 { return .unconfirmed(.unreadable) }
            switch error.code {
            case .rate_limited: return .unconfirmed(.rateLimited(retryAfterSeconds: error.retryAfterSeconds))
            case ._internal: return .unconfirmed(.serverProblem)
            default:
                return error.status >= 500 ? .unconfirmed(.serverProblem) : .unconfirmed(.refused(message: error.message))
            }

        case .failure(.unexpectedResponse(let status)):
            return .unconfirmed(status >= 500 ? .serverProblem : .unreadable)
        case .failure(.undecodableResponse):
            return .unconfirmed(.unreadable)
        case .failure(.unreachable), .failure(.cancelled):
            return .unconfirmed(.noConnection)
        }
    }
}

/// Every decision the checkout makes, as plain Swift over `CheckoutServing` and `PendingCheckoutStore`,
/// so all of it runs in unit tests. One instance lives for the app; the screen only renders `screen`
/// and `form` and forwards taps.
///
/// ## One idempotency key per attempt, written down before it is used
/// An attempt is one `InitializeRequest`. Its key is made when the attempt is made and written to the
/// Keychain BEFORE the request leaves; if it cannot be written, nothing is sent (`PayPhase.notRecorded`,
/// the one place "No money was taken" is a fact). From then on the attempt is the slot for its link code,
/// one per code per DEVICE, found by `open` before any session has resolved.
///
/// - A retry resends the identical request under the identical key (`retry`). A key is never minted
///   while an attempt of unknown outcome exists for the link. The form is not even shown then, so the
///   request cannot be edited under the old key.
/// - A key is minted only by `pay` from the form, which is shown only when there is no slot: after a
///   settled refusal (the slot is gone and the link is read afresh, so a changed price is seen before a
///   new key is made) or after the person's confirmed `startOver`.
/// - The slot is removed only by: a `SendVerdict.settled` or `.rejected` answer; `startOver`; the dismissal of a
///   finished payment (below); and `sessionDidChange` (explicit sign-out, or a different confirmed user). An
///   involuntary session end removes nothing. A remove that fails is reported, never swallowed: `startOver` says
///   so and changes nothing; a failed sign-out cleanup hides what it could not remove until a retry succeeds.
/// - No silent retry: one `initializeCheckout` call per `send`, and `KobolinkAPIClient` never resends a POST.
///
/// ## Verify settles, and only verify
/// A reference exists once `initialize` answers 201; from then on the controller asks `verify` (right away, whether
/// or not the screen is still open, and again every time the link is opened). A `VerifyVerdict.decided` answer
/// marks the slot `settled` (durably, before the screen changes); the slot is REMOVED only when the person has seen
/// the result and dismisses it (`close`, opening another link, `startOver`). So a payment cannot be forgotten
/// before it has been seen, and a result survives Back, a relaunch and a process kill. Nothing else settles a started
/// payment: a 5xx, a 429, a dropped connection, a redirect, a 401 or an unreadable body leave the slot as it is
/// (`Unconfirmed`), with "Check Again" and without ever saying no money moved. Verify is safe to repeat (a reference
/// is decided once, under any key: `apps/api/test/checkout-verify.integration.test.ts`), so each ask carries a fresh
/// key (`makeVerifyKey`, never `makeKey`: the key a payment was INITIALIZED under is never minted again).
/// A `pending` answer is re-asked a bounded number of times (`verifyDelays`), then waits for the person.
///
/// ## Latest wins
/// Every `open` and `close` starts a new lookup generation; a lookup answer is applied only if its
/// generation is still current and its link is still the open one. A payment answer is applied to the
/// screen only while its attempt is still the one on screen, but its effect on the SLOT is always
/// applied (the reference is stored even if the person has gone to another link), unless the person
/// signed out or changed in the meantime, when the attempt is already gone from storage and the answer finds
/// nothing to update.
///
/// ## Ownership
/// See `AttemptOwner`. `sessionDidChange` applies the rule; nothing else touches ownership.
@MainActor
@Observable
public final class CheckoutController {
    public private(set) var screen: CheckoutScreen = .idle
    public let form = CheckoutForm()

    @ObservationIgnored private let service: any CheckoutServing
    @ObservationIgnored private let store: any PendingCheckoutStore
    @ObservationIgnored private let ownerNow: @MainActor () -> AttemptOwner
    @ObservationIgnored private let makeKey: @Sendable () -> String
    @ObservationIgnored private let makeVerifyKey: @Sendable () -> String
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let verifyDelays: [Duration]
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void

    /// How long to wait before each automatic re-ask after a `pending` answer. Its length is the bound: three
    /// automatic checks (about 14 seconds), then the person decides.
    public static let defaultVerifyDelays: [Duration] = [.seconds(2), .seconds(4), .seconds(8)]

    /// The link the checkout is open on (it follows the navigation stack's single link).
    @ObservationIgnored private var openCode: LinkCode?
    @ObservationIgnored private var lookupGeneration = 0
    @ObservationIgnored private var lookupTask: Task<Void, Never>?
    /// What to show once the next lookup succeeds (a price notice, a validation refusal).
    @ObservationIgnored private var lookupCarry: LookupCarry?
    /// The attempt for `openCode`, mirrored in the store.
    @ObservationIgnored private var held: Held?
    /// Keys whose request is in flight now.
    @ObservationIgnored private var inFlight: Set<String> = []
    /// Keys of attempts whose `verify` request is in flight now (one at a time per attempt).
    @ObservationIgnored private var inFlightVerify: Set<String> = []
    /// The wait before the next automatic `verify`, for the attempt it belongs to.
    @ObservationIgnored private var poll: (key: String, task: Task<Void, Never>)?
    @ObservationIgnored private var confirmedUserID: String?
    /// What a sign-out still owes the device. It is written to storage BEFORE the sign-out, read again by a new
    /// process BEFORE anything else a session event does (a merge or an adoption without it would overwrite or
    /// relabel what it names), and hides what it names until the removal succeeds.
    @ObservationIgnored private var owed: SignOutObligation?
    @ObservationIgnored private var obligationLoaded = false
    /// Set when a sign-out could not be prepared in time: every session attempt is hidden until it can be.
    @ObservationIgnored private var hideSessionAttempts = false
    /// A user whose adoption of unconfirmed attempts could not be saved; retried the next time a link is shown.
    @ObservationIgnored private var pendingAdoption: String?

    private enum LookupCarry: Equatable {
        case priceRefused
        case rejected(message: String)
    }

    private struct Held {
        var pending: PendingCheckout
        var phase: AttemptPhase
        /// Automatic re-asks already made after a `pending` answer.
        var pollStep = 0
    }

    public init(
        service: any CheckoutServing,
        store: any PendingCheckoutStore,
        ownerNow: @escaping @MainActor () -> AttemptOwner = { .payer },
        makeKey: @escaping @Sendable () -> String = IdempotencyKey.make,
        makeVerifyKey: @escaping @Sendable () -> String = IdempotencyKey.make,
        now: @escaping @Sendable () -> Date = { Date() },
        verifyDelays: [Duration] = CheckoutController.defaultVerifyDelays,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.service = service
        self.store = store
        self.ownerNow = ownerNow
        self.makeKey = makeKey
        self.makeVerifyKey = makeVerifyKey
        self.now = now
        self.verifyDelays = verifyDelays
        self.sleep = sleep
    }

    // MARK: - Opening and closing

    /// Show `code`: the remembered attempt for it if there is one (no network, no session needed),
    /// otherwise look the link up. Opening a different link empties the form.
    public func open(_ code: LinkCode) {
        if openCode != code {
            dismissResult()
            cancelPoll()
            form.reset()
            held = nil
            lookupCarry = nil
        }
        openCode = code
        lookupGeneration += 1
        lookupTask?.cancel()
        present(code)
    }

    /// The link left the screen (Back, or a link that is not one). Nothing in flight can reach the
    /// screen afterwards, and the form is emptied so Back can never land on a stale one. A finished payment that
    /// was on screen has been seen: it is forgotten here (a removal that fails only means it is shown once more).
    public func close() {
        dismissResult()
        cancelPoll()
        openCode = nil
        held = nil
        lookupCarry = nil
        lookupGeneration += 1
        lookupTask?.cancel()
        lookupTask = nil
        form.reset()
        screen = .idle
    }

    /// "Try again" on a failed lookup, "Check again" on a notice: look the link up again.
    public func reload() {
        guard let code = openCode else { return }
        open(code)
    }

    // MARK: - Paying

    /// Start a payment for what is in the form. Ignored unless a payable link is on screen and no
    /// request is in flight (a double tap is one request).
    public func pay() {
        guard case .link(var linkScreen) = screen, linkScreen.availability == .payable, !linkScreen.pay.isBusy else { return }
        let link = linkScreen.link

        let input: PayerInput
        switch PayerValidation.validate(
            fixedAmountKobo: link.amountKobo, amountText: form.amountText, name: form.name, email: form.email)
        {
        case .invalid(let errors):
            form.errors = errors
            return
        case .valid(let valid):
            input = valid
        }
        form.errors = [:]

        let request = InitializeRequest(
            code: link.code, amountKobo: input.amountKobo, payerName: input.name, payerEmail: input.email)
        let pending = PendingCheckout(
            key: makeKey(), request: request, owner: ownerNow(),
            merchantName: link.merchantName, title: link.title, createdAt: now())

        // Write it down BEFORE the request leaves. If the process dies mid-flight the next one knows which
        // key to retry under. If it cannot be written, nothing is sent: an unrecorded payment could be
        // made twice.
        do throws(PendingStoreError) {
            try store.save(pending)
        } catch {
            linkScreen.pay = .notRecorded
            screen = .link(linkScreen)
            return
        }

        held = Held(pending: pending, phase: .sending)
        linkScreen.pay = .submitting
        screen = .link(linkScreen)
        send(pending, firstEverSend: true)
    }

    /// "Try again" on an attempt of unknown outcome: the SAME request under the SAME key. Nothing is
    /// written first (the key is already stored), so a storage failure cannot turn a replay into a new
    /// attempt, and nothing the server says about this replay alone can end the attempt.
    public func retry() {
        guard case .attempt(var attempt) = screen, case .unsettled = attempt.phase,
            var current = held, current.pending.request.code == attempt.code,
            !inFlight.contains(current.pending.key)
        else { return }
        current.phase = .sending
        held = current
        attempt.phase = .sending
        attempt.startOverFailed = false
        screen = .attempt(attempt)
        send(current.pending, firstEverSend: false)
    }

    /// "Check Again" on a started payment `verify` has not decided: ask the server again. It cannot start a second
    /// payment (a reference is decided once), and the slot is not touched.
    public func checkAgain() {
        guard case .attempt(var attempt) = screen, case .unconfirmed = attempt.phase,
            var current = held, current.pending.request.code == attempt.code, current.pending.reference != nil,
            !inFlightVerify.contains(current.pending.key)
        else { return }
        current.phase = .verifying(stillProcessing: false)
        current.pollStep = 0
        held = current
        attempt.phase = current.phase
        attempt.startOverFailed = false
        screen = .attempt(attempt)
        startVerify(current.pending)
    }

    /// "Start a new payment", after the person confirmed: forget the remembered attempt, here and in the
    /// Keychain, and read the link afresh. The form opens EMPTY: what the earlier attempt held (a name and an
    /// email) is never shown to whoever is holding the phone, only sent again in a same-key replay.
    ///
    /// Also "Try Again" on a payment the server has FINISHED without moving money (declined, link unavailable, no
    /// such checkout): that outcome is settled, so no confirmation is needed. A paid one is never offered again.
    ///
    /// If the Keychain will not let go of it, NOTHING changes and the screen says so: a button that does
    /// nothing, or that forgets the attempt only in memory, would bring it back after a restart.
    public func startOver() {
        switch screen {
        case .attempt(var attempt):
            guard !inFlight.contains(held?.pending.key ?? ""), !inFlightVerify.contains(held?.pending.key ?? "") else { return }
            do throws(PendingStoreError) {
                try store.remove(attempt.code)
            } catch {
                attempt.startOverFailed = true
                screen = .attempt(attempt)
                return
            }
            cancelPoll()
            form.reset()
            held = nil
            lookupCarry = nil
            showLookup(attempt.code)

        case .result(var result):
            guard !result.result.moneyMoved else { return }
            do throws(PendingStoreError) {
                try store.remove(result.code)
            } catch {
                result.actionFailed = true
                screen = .result(result)
                return
            }
            form.reset()
            held = nil
            lookupCarry = nil
            showLookup(result.code)

        case .storageBlocked(let code, .undecodable), .storageBlocked(let code, .undecodableClearFailed):
            do throws(PendingStoreError) {
                try store.remove(slotID: code.value)
            } catch {
                // The confirmed button must not do nothing in silence.
                screen = .storageBlocked(code, .undecodableClearFailed)
                return
            }
            form.reset()
            held = nil
            showLookup(code)

        default:
            return
        }
    }

    // MARK: - Lookup

    /// Decide what `code` shows: its remembered attempt, a block, or a fresh lookup.
    private func present(_ code: LinkCode) {
        // What a previous process owed comes first: until it is known, no slot may be shown.
        switch loadObligationOnce() {
        case .ok:
            break
        case .unavailable:
            held = nil
            screen = .storageBlocked(code, .unreadable)
            return
        case .undecodable:
            held = nil
            screen = .storageBlocked(code, .obligationUnreadable)
            return
        }
        runOwed()
        if let user = pendingAdoption { adoptUnconfirmed(by: user) }

        let slot: PendingCheckout?
        do throws(PendingStoreError) {
            slot = try store.load(code)
        } catch {
            held = nil
            screen = .storageBlocked(code, error.kind == .undecodable ? .undecodable : .unreadable)
            return
        }

        guard let slot else {
            held = nil
            showLookup(code)
            return
        }
        if isHidden(slot) {
            // An earlier session's attempt that could not be removed: never shown, never resumed.
            held = nil
            screen = .storageBlocked(code, .cannotClear)
            return
        }
        if case .session(let id?) = slot.owner, let me = confirmedUserID, id != me {
            // Another CONFIRMED user's attempt is never shown to this one: remove it, or if that fails, hide it.
            held = nil
            do throws(PendingStoreError) {
                try store.remove(code)
                showLookup(code)
            } catch {
                screen = .storageBlocked(code, .cannotClear)
            }
            return
        }

        // Read back from storage, an attempt may already have been sent in an earlier run: unknown until
        // something answers it.
        var current: Held
        if let existing = held, existing.pending.key == slot.key {
            current = existing
            let reference = existing.pending.reference
            let confirmed = existing.pending.confirmedAmountKobo
            let settled = existing.pending.settled
            current.pending = slot
            // The answer is in memory even if writing it down failed.
            if slot.reference == nil, reference != nil {
                current.pending.reference = reference
                current.pending.confirmedAmountKobo = confirmed
            }
            if slot.settled == nil, settled != nil { current.pending.settled = settled }
        } else {
            current = Held(pending: slot, phase: .unsettled(.interrupted))
        }

        if current.pending.reference != nil {
            // Decided already: show how it ended, with no network. It stays until the person has seen it.
            if let result = current.pending.settled {
                held = current
                screen = .result(Self.resultScreen(for: current.pending, result))
                return
            }
            // Started and not decided: ask. This runs every time the link is shown, so a payment that was
            // started and left (Back, a relaunch, a dropped connection) is confirmed when the person returns.
            // If an ask is already in the air, or one is waiting its turn, this joins it rather than adding one.
            let waiting = inFlightVerify.contains(slot.key) || poll?.key == slot.key
            if case .verifying = current.phase, waiting {
                // keep what it was showing, including "still processing"
            } else {
                current.phase = .verifying(stillProcessing: false)
                current.pollStep = 0
            }
            held = current
            screen = .attempt(Self.attemptScreen(for: current))
            if !waiting { startVerify(current.pending) }
            return
        }
        if inFlight.contains(slot.key) {
            current.phase = .sending
        } else if case .sending = current.phase {
            current.phase = .unsettled(.interrupted)
        }
        held = current
        screen = .attempt(Self.attemptScreen(for: current))
    }

    private static func resultScreen(for pending: PendingCheckout, _ result: PaymentResult) -> ResultScreen {
        ResultScreen(
            code: pending.request.code,
            merchantName: pending.merchantName,
            title: pending.title,
            amountKobo: pending.confirmedAmountKobo ?? pending.request.amountKobo,
            reference: pending.reference ?? "",
            result: result
        )
    }

    private static func attemptScreen(for held: Held, startOverFailed: Bool = false) -> AttemptScreen {
        AttemptScreen(
            code: held.pending.request.code,
            merchantName: held.pending.merchantName,
            title: held.pending.title,
            amountKobo: held.pending.confirmedAmountKobo ?? held.pending.request.amountKobo,
            reference: held.pending.reference,
            phase: held.phase,
            startOverFailed: startOverFailed
        )
    }

    private func showLookup(_ code: LinkCode) {
        screen = .loading(code)
        startLookup(code)
    }

    private func startLookup(_ code: LinkCode) {
        lookupGeneration += 1
        let mine = lookupGeneration
        lookupTask?.cancel()
        let service = self.service
        lookupTask = Task { [weak self] in
            let result: Result<LinkLookup, APIError>
            do throws(APIError) {
                result = .success(try await service.lookupLink(code: code))
            } catch {
                result = .failure(error)
            }
            self?.applyLookup(result, code: code, generation: mine)
        }
    }

    private func applyLookup(_ result: Result<LinkLookup, APIError>, code: LinkCode, generation: Int) {
        // Latest wins: an answer for a link the person has left, or one superseded by a newer lookup,
        // is dropped.
        guard generation == lookupGeneration, openCode == code else { return }
        switch result {
        case .success(let lookup):
            guard lookup.link.code == code else {
                screen = .loadFailed(code, .unreadable)
                return
            }
            var pay = PayPhase.editing
            if lookup.availability == .payable {
                switch lookupCarry {
                case .priceRefused?:
                    if let price = lookup.link.amountKobo { pay = .priceChanged(newAmountKobo: price) }
                case .rejected(let message)?:
                    pay = .rejected(message: message)
                case nil:
                    break
                }
            }
            lookupCarry = nil
            screen = .link(LinkScreen(link: lookup.link, availability: lookup.availability, pay: pay))

        case .failure(.server(let error)) where error.code == .not_found && error.status == 404:
            lookupCarry = nil
            screen = .notFound(code)
        case .failure(let error):
            screen = .loadFailed(code, Self.loadFailure(for: error))
        }
    }

    private static func loadFailure(for error: APIError) -> LoadFailure {
        switch error {
        case .unreachable, .cancelled: .noConnection
        case .server(let server):
            server.code == .rate_limited
                ? .rateLimited(retryAfterSeconds: server.retryAfterSeconds)
                : (server.status >= 500 ? .serverProblem : .unreadable)
        case .unexpectedResponse(let status): status >= 500 ? .serverProblem : .unreadable
        case .undecodableResponse: .unreadable
        }
    }

    // MARK: - Sending

    struct SendContext {
        let pending: PendingCheckout
        let firstEverSend: Bool
    }

    private func send(_ pending: PendingCheckout, firstEverSend: Bool) {
        let context = SendContext(pending: pending, firstEverSend: firstEverSend)
        inFlight.insert(pending.key)
        let service = self.service
        // Unstructured on purpose: leaving the screen must not cancel a payment request half way, because
        // then the answer (the reference) would be lost along with the screen. Whether the answer reaches
        // the SCREEN is `applyOutcome`'s decision.
        Task { [weak self] in
            let result: Result<StartedCheckout, APIError>
            do throws(APIError) {
                result = .success(try await service.initializeCheckout(pending.request, idempotencyKey: pending.key))
            } catch {
                result = .failure(error)
            }
            self?.applyOutcome(result, context: context)
        }
    }

    func applyOutcome(_ result: Result<StartedCheckout, APIError>, context: SendContext) {
        let pending = context.pending
        inFlight.remove(pending.key)
        // If the person signed out or changed while it was in the air, their attempt is already gone from
        // storage and from `held`, and nothing below creates a slot: it only updates or removes the one
        // that still holds THIS key, so a late answer cannot bring a cleared attempt back.

        let verdict = SendVerdict.of(result, request: pending.request, firstEverSend: context.firstEverSend)
        let code = pending.request.code
        // Does the screen still show THIS attempt?
        let onScreen = openCode == code && held?.pending.key == pending.key

        switch verdict {
        case .started(let started):
            guard recordReference(started, for: pending) else { return }
            var withReference = pending
            withReference.reference = started.reference
            withReference.confirmedAmountKobo = started.amountKobo
            if onScreen, var current = held {
                current.pending.reference = started.reference
                current.pending.confirmedAmountKobo = started.amountKobo
                current.phase = .verifying(stillProcessing: false)
                current.pollStep = 0
                held = current
                screen = .attempt(Self.attemptScreen(for: current))
            }
            // The person pressed Pay: confirm the payment whether or not the screen is still open.
            startVerify(withReference)

        case .settled(let error):
            removeSlot(for: pending)
            guard onScreen else { return }
            held = nil
            if error.code == .not_found {
                screen = .notFound(code)
            } else {
                // The link stopped being payable, or was repriced: read it afresh and show what is true now.
                lookupCarry = error.code == .amount_mismatch ? .priceRefused : nil
                showLookup(code)
            }

        case .rejected(let error):
            removeSlot(for: pending)
            guard onScreen else { return }
            held = nil
            let fields = Dictionary(
                uniqueKeysWithValues: error.fieldErrors.compactMap { name, messages -> (PayerField, String)? in
                    guard let field = PayerField(wireName: name), let first = messages.first else { return nil }
                    return (field, first)
                })
            form.errors = fields
            let message = CheckoutCopy.rejection(message: error.message, hasFieldErrors: !fields.isEmpty)
            if case .link(var linkScreen) = screen {
                linkScreen.pay = .rejected(message: message)
                screen = .link(linkScreen)
            } else {
                lookupCarry = .rejected(message: message)
                showLookup(code)
            }

        case .unsettled(let reason):
            // A late "could not confirm" never takes back an answer that has already arrived.
            guard onScreen, var current = held, current.pending.reference == nil else { return }
            current.phase = .unsettled(reason)
            held = current
            screen = .attempt(Self.attemptScreen(for: current))
        }
    }

    /// Store the reference with the attempt. `false` means the attempt is gone from storage (the person
    /// cleared it meanwhile), and the answer is dropped. A storage failure keeps the key, which is what
    /// matters: a replay returns the same reference.
    private func recordReference(_ started: StartedCheckout, for pending: PendingCheckout) -> Bool {
        do throws(PendingStoreError) {
            guard var stored = try store.load(pending.request.code), stored.key == pending.key else { return false }
            stored.reference = started.reference
            stored.confirmedAmountKobo = started.amountKobo
            try store.save(stored)
        } catch {
            return true
        }
        return true
    }

    /// Remove the attempt's slot if it still holds this attempt. One retry, since nobody is told about it:
    /// a slot that stays only brings back an interrupted attempt whose replay returns the same refusal.
    private func removeSlot(for pending: PendingCheckout) {
        func attempt() -> Bool {
            do throws(PendingStoreError) {
                guard let stored = try store.load(pending.request.code), stored.key == pending.key else { return true }
                try store.remove(pending.request.code)
                return true
            } catch {
                return false
            }
        }
        if !attempt() { _ = attempt() }
    }

    // MARK: - Verifying

    struct VerifyContext {
        let pending: PendingCheckout
        let reference: String
    }

    /// Ask the server how `pending` was decided. One request, under a key made for this ask: a reference is decided
    /// once, under any key, so asking again can never post a second time, and a fresh key cannot be answered with a
    /// stale stored reply. Unstructured on purpose, like `send`: leaving the screen must not drop an answer that
    /// decides a payment. Whether the answer reaches the SCREEN is `applyVerify`'s decision.
    private func startVerify(_ pending: PendingCheckout) {
        guard let reference = pending.reference, pending.settled == nil, !inFlightVerify.contains(pending.key) else { return }
        inFlightVerify.insert(pending.key)
        let context = VerifyContext(pending: pending, reference: reference)
        let key = makeVerifyKey()
        let service = self.service
        Task { [weak self] in
            let result: Result<VerifiedPayment, APIError>
            do throws(APIError) {
                result = .success(try await service.verifyCheckout(reference: reference, idempotencyKey: key))
            } catch {
                result = .failure(error)
            }
            self?.applyVerify(result, context: context)
        }
    }

    func applyVerify(_ result: Result<VerifiedPayment, APIError>, context: VerifyContext) {
        let pending = context.pending
        inFlightVerify.remove(pending.key)
        let code = pending.request.code
        let verdict = VerifyVerdict.of(
            result, reference: context.reference, code: code,
            amountKobo: pending.confirmedAmountKobo ?? pending.request.amountKobo)
        // Does the screen still show THIS attempt?
        let onScreen = openCode == code && held?.pending.key == pending.key

        switch verdict {
        case .decided(let outcome):
            // Written down BEFORE the screen changes, so a kill right now still finds the result. `false` means the
            // attempt is gone from storage (sign-out, start over): there is nothing left to settle, and the answer is dropped.
            guard recordSettled(outcome, for: pending, reference: context.reference) else { return }
            if poll?.key == pending.key { cancelPoll() }
            guard onScreen, var current = held else { return }
            current.pending.reference = context.reference
            current.pending.settled = outcome
            held = current
            screen = .result(Self.resultScreen(for: current.pending, outcome))

        case .notDecided:
            guard onScreen, var current = held, current.pending.settled == nil else { return }
            let step = current.pollStep
            if step < verifyDelays.count {
                current.pollStep = step + 1
                current.phase = .verifying(stillProcessing: true)
                held = current
                screen = .attempt(Self.attemptScreen(for: current))
                schedulePoll(for: current.pending.key, delay: verifyDelays[step])
            } else {
                current.phase = .unconfirmed(.stillProcessing)
                held = current
                screen = .attempt(Self.attemptScreen(for: current))
            }

        case .unconfirmed(let reason):
            // A late "could not confirm" never takes back a result that has already arrived.
            guard onScreen, var current = held, current.pending.settled == nil else { return }
            current.phase = .unconfirmed(reason)
            held = current
            screen = .attempt(Self.attemptScreen(for: current))
        }
    }

    /// Mark the attempt's slot `settled`. `false` means the slot no longer holds this attempt. A storage failure
    /// is not that: the answer is still shown (and asked again, with the same result, if the app is closed first).
    private func recordSettled(_ outcome: PaymentResult, for pending: PendingCheckout, reference: String) -> Bool {
        do throws(PendingStoreError) {
            guard var stored = try store.load(pending.request.code), stored.key == pending.key else { return false }
            stored.reference = stored.reference ?? reference
            stored.confirmedAmountKobo = stored.confirmedAmountKobo ?? pending.confirmedAmountKobo
            stored.settled = outcome
            try store.save(stored)
        } catch {
            return true
        }
        return true
    }

    private func schedulePoll(for key: String, delay: Duration) {
        cancelPoll()
        let sleep = self.sleep
        let task = Task { [weak self] in
            do { try await sleep(delay) } catch { return }
            guard !Task.isCancelled else { return }
            self?.pollIsDue(key: key)
        }
        poll = (key, task)
    }

    private func pollIsDue(key: String) {
        guard poll?.key == key else { return }
        poll = nil
        guard let code = openCode, let current = held, current.pending.key == key,
            current.pending.request.code == code, case .verifying = current.phase, current.pending.settled == nil
        else { return }
        startVerify(current.pending)
    }

    private func cancelPoll() {
        poll?.task.cancel()
        poll = nil
    }

    /// The person has seen a finished payment and is leaving it: forget it here and in the Keychain. If the removal
    /// fails nothing is lost: the next time the link opens it shows the same result, and "Done" tries again.
    private func dismissResult() {
        guard case .result = screen, let pending = held?.pending, pending.settled != nil else { return }
        removeSlot(for: pending)
    }

    // MARK: - The session

    /// Whether any attempt made under a session is stored, for the sign-out confirmation. Storage that
    /// cannot be listed counts as "yes": the safe answer is to ask. A finished payment is not an unfinished one:
    /// it is still removed by a sign-out, but it is not worth a warning.
    public var hasSessionAttempts: Bool {
        guard let slots = try? store.all() else { return true }
        return slots.contains { slot in
            switch slot {
            case .pending(let pending): pending.owner.isSession && pending.settled == nil
            case .unreadable: true
            }
        }
    }

    /// Asked by the session BEFORE it signs the person out. It writes down what the sign-out owes (every session
    /// attempt and unreadable slot on the device, by identity) and returns `true` only when that is safely stored,
    /// or when nothing is owed. `false` means the sign-out must not happen: a sign-out whose clearing could be
    /// forgotten by a restart would show this person's attempt to whoever holds the phone.
    public func prepareSignOut() -> Bool {
        guard loadObligationOnce() == .ok else { return false }
        let slots: [PendingSlot]
        do throws(PendingStoreError) {
            slots = try store.all()
        } catch {
            return false
        }
        var entries = owed?.entries ?? []
        for slot in slots {
            switch slot {
            case .pending(let pending) where pending.owner.isSession:
                entries.append(.init(code: pending.request.code.value, key: pending.key))
            case .unreadable(let slotID):
                entries.append(.init(code: slotID, key: nil))
            case .pending:
                break
            }
        }
        var seen = Set<SignOutObligation.Entry>()
        let unique = entries.filter { seen.insert($0).inserted }
        guard !unique.isEmpty else {
            hideSessionAttempts = false
            return true
        }
        let obligation = SignOutObligation(entries: unique)
        do throws(PendingStoreError) {
            try store.saveObligation(obligation)
        } catch {
            return false
        }
        owed = obligation
        hideSessionAttempts = false
        return true
    }

    /// React to a change in who is signed in; `AttemptOwner` states the rule.
    public func sessionDidChange(_ change: SessionChange) {
        switch change {
        case .ended:
            // An involuntary end says nothing about who is holding the phone: nothing is forgotten.
            return

        case .signedOutByChoice:
            confirmedUserID = nil
            pendingAdoption = nil
            // The session asked first (`prepareSignOut`), so this is normally a repeat. If it cannot be made safe
            // now, every session attempt is hidden until it can be.
            if !prepareSignOut() { hideSessionAttempts = true }
            runOwed()
            resetOpenScreen()

        case .resolved(let user):
            let previous = confirmedUserID
            confirmedUserID = user.id
            settle(after: user)
            if let previous, previous != user.id {
                resetOpenScreen()
            }

        case .signedIn(let user):
            // A sign-in NEVER drops an attempt whose owner was not confirmed: it may be the same person's, with an
            // outcome nobody has seen, and forgetting it would let the form mint a second key. The person who signs
            // in adopts it, unless a sign-out owes its removal. Only another CONFIRMED user's attempts are removed.
            confirmedUserID = user.id
            settle(after: user)
            resetOpenScreen()
        }
    }

    /// What follows a confirmed user, in this order: what a previous sign-out owed is read FIRST (an adoption before
    /// it would relabel an attempt it names), then carried out, then other users' attempts go, then the
    /// unconfirmed ones are adopted. If the obligation cannot be read, nothing here proceeds, and adoption waits.
    private func settle(after user: SignedInUser) {
        guard loadObligationOnce() == .ok else {
            pendingAdoption = user.id
            return
        }
        runOwed()
        if let slots = try? store.all() {
            for case .pending(let pending) in slots {
                if case .session(let id?) = pending.owner, id != user.id { try? store.remove(pending.request.code) }
            }
        }
        adoptUnconfirmed(by: user.id)
    }

    /// Empty everything that belongs to the person who was here, and show the open link again as it looks
    /// to whoever is here now.
    private func resetOpenScreen() {
        cancelPoll()
        form.reset()
        held = nil
        lookupCarry = nil
        // `inFlight` is NOT cleared: a request still in the air for an attempt that was not removed (a payer's) is
        // still in the air, and shows as sending so it cannot be sent twice at once.
        guard let code = openCode else {
            screen = .idle
            return
        }
        lookupGeneration += 1
        lookupTask?.cancel()
        present(code)
    }

    private enum ObligationRead { case ok, unavailable, undecodable }

    /// Reads what a previous process owed. A throw is "could not find out", and then no slot is shown and nothing is
    /// merged or saved: guessing "nothing owed" could show a signed-out person's attempt, or overwrite the record.
    private func loadObligationOnce() -> ObligationRead {
        if obligationLoaded { return .ok }
        do throws(PendingStoreError) {
            owed = try store.loadObligation()
            obligationLoaded = true
            return .ok
        } catch {
            return error.kind == .undecodable ? .undecodable : .unavailable
        }
    }

    /// Is this attempt one a sign-out owes the removal of (or one hidden because a sign-out could not be prepared)?
    private func isHidden(_ pending: PendingCheckout) -> Bool {
        if owed?.contains(code: pending.request.code.value, key: pending.key) == true { return true }
        return hideSessionAttempts && pending.owner.isSession
    }

    /// Remove what a sign-out owes. A removal that fails leaves the obligation in place (it keeps hiding what it
    /// names); it is never swallowed.
    private func runOwed() {
        guard let current = owed else { return }
        let slots: [PendingSlot]
        do throws(PendingStoreError) {
            slots = try store.all()
        } catch {
            return
        }
        var complete = true
        for slot in slots {
            switch slot {
            case .pending(let pending) where current.contains(code: pending.request.code.value, key: pending.key):
                do throws(PendingStoreError) {
                    try store.remove(pending.request.code)
                    inFlight.remove(pending.key)
                    inFlightVerify.remove(pending.key)
                } catch {
                    complete = false
                }
            case .unreadable(let slotID) where current.contains(code: slotID, key: nil):
                do throws(PendingStoreError) {
                    try store.remove(slotID: slotID)
                } catch {
                    complete = false
                }
            default:
                break
            }
        }
        guard complete else { return }
        owed = nil
        // If the marker cannot be taken back it names attempts that are gone (keys are never reused), so the next
        // process finds nothing to remove and tries again.
        try? store.clearObligation()
    }

    /// The safe exit when the record of what a sign-out owes cannot be read: forget EVERY payment saved on this
    /// iPhone and the record itself, after the person confirmed ("If you already paid, check with the merchant
    /// first"). If storage will not let go, nothing changes and the screen says so.
    public func resetCheckoutData() {
        guard case .storageBlocked(let code, let block) = screen, block == .obligationUnreadable || block == .resetFailed else { return }
        do throws(PendingStoreError) {
            for slot in try store.all() {
                switch slot {
                case .pending(let pending): try store.remove(pending.request.code)
                case .unreadable(let slotID): try store.remove(slotID: slotID)
                }
            }
            try store.clearObligation()
        } catch {
            screen = .storageBlocked(code, .resetFailed)
            return
        }
        owed = nil
        obligationLoaded = true
        hideSessionAttempts = false
        pendingAdoption = nil
        inFlight = []
        inFlightVerify = []
        cancelPoll()
        form.reset()
        held = nil
        present(code)
    }

    /// The check, or a sign-in, confirmed whose session this is: attempts made before it finished get their
    /// owner, except those a sign-out owes the removal of. An attempt that cannot be saved with its new owner is
    /// KEPT (never dropped, never swallowed) and adoption is retried the next time a link is shown.
    private func adoptUnconfirmed(by userID: String) {
        pendingAdoption = nil
        let slots: [PendingSlot]
        do throws(PendingStoreError) {
            slots = try store.all()
        } catch {
            pendingAdoption = userID
            return
        }
        for case .pending(var pending) in slots where pending.owner == .session(userID: nil) && !isHidden(pending) {
            pending.owner = .session(userID: userID)
            do throws(PendingStoreError) {
                try store.save(pending)
            } catch {
                pendingAdoption = userID
                continue
            }
            if held?.pending.key == pending.key { held?.pending.owner = pending.owner }
        }
    }
}
