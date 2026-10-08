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

    func fill(from request: InitializeRequest) {
        name = request.payerName
        email = request.payerEmail
        amountText = Kobo.fieldText(request.amountKobo)
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
/// - The slot is removed only by: a `SendVerdict.settled` or `.rejected` answer; `startOver`; and
///   `sessionDidChange` (explicit sign-out, or a different confirmed user). An involuntary session end
///   removes nothing. A remove that fails is reported, never swallowed: `startOver` says so and changes
///   nothing; a failed sign-out cleanup hides what it could not remove until a retry succeeds.
/// - No silent retry: one `initializeCheckout` call per `send`, and `KobolinkAPIClient` never resends a POST.
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
    @ObservationIgnored private let now: @Sendable () -> Date

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
    @ObservationIgnored private var confirmedUserID: String?
    @ObservationIgnored private var pendingCleanup: Cleanup?

    private enum LookupCarry: Equatable {
        case priceRefused
        case rejected(message: String)
    }

    private struct Held {
        var pending: PendingCheckout
        var phase: AttemptPhase
    }

    /// A removal that has to happen and, if it could not, keeps hiding what it would remove.
    private enum Cleanup: Equatable {
        /// Explicit sign-out: every attempt made while a session existed.
        case allSession
        /// A confirmed user: the attempts of others, and (after a sign-in with credentials) those whose
        /// owner was never confirmed.
        case foreign(user: String, dropUnconfirmed: Bool)

        func removes(_ owner: AttemptOwner) -> Bool {
            switch (self, owner) {
            case (_, .payer): false
            case (.allSession, .session): true
            case (.foreign(_, let dropUnconfirmed), .session(nil)): dropUnconfirmed
            case (.foreign(let user, _), .session(let id?)): id != user
            }
        }
    }

    public init(
        service: any CheckoutServing,
        store: any PendingCheckoutStore,
        ownerNow: @escaping @MainActor () -> AttemptOwner = { .payer },
        makeKey: @escaping @Sendable () -> String = IdempotencyKey.make,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.service = service
        self.store = store
        self.ownerNow = ownerNow
        self.makeKey = makeKey
        self.now = now
    }

    // MARK: - Opening and closing

    /// Show `code`: the remembered attempt for it if there is one (no network, no session needed),
    /// otherwise look the link up. Opening a different link empties the form.
    public func open(_ code: LinkCode) {
        if openCode != code {
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
    /// screen afterwards, and the form is emptied so Back can never land on a stale one.
    public func close() {
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

    /// "Start a new payment", after the person confirmed: forget the remembered attempt, here and in the
    /// Keychain, and read the link afresh. The form is filled with what was sent so it can be corrected.
    ///
    /// If the Keychain will not let go of it, NOTHING changes and the screen says so: a button that does
    /// nothing, or that forgets the attempt only in memory, would bring it back after a restart.
    public func startOver() {
        switch screen {
        case .attempt(var attempt):
            guard !inFlight.contains(held?.pending.key ?? "") else { return }
            do throws(PendingStoreError) {
                try store.remove(attempt.code)
            } catch {
                attempt.startOverFailed = true
                screen = .attempt(attempt)
                return
            }
            if let request = held?.pending.request { form.fill(from: request) }
            held = nil
            lookupCarry = nil
            showLookup(attempt.code)

        case .storageBlocked(let code, .undecodable):
            do throws(PendingStoreError) {
                try store.remove(slotID: code.value)
            } catch {
                return
            }
            held = nil
            showLookup(code)

        default:
            return
        }
    }

    // MARK: - Lookup

    /// Decide what `code` shows: its remembered attempt, a block, or a fresh lookup.
    private func present(_ code: LinkCode) {
        if pendingCleanup != nil { runCleanup() }

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
        if let cleanup = pendingCleanup, cleanup.removes(slot.owner) {
            // An earlier session's attempt that could not be removed: never shown, never resumed.
            held = nil
            screen = .storageBlocked(code, .cannotClear)
            return
        }

        // Read back from storage, an attempt may already have been sent in an earlier run: unknown until
        // something answers it.
        var current: Held
        if let existing = held, existing.pending.key == slot.key {
            current = existing
            let reference = existing.pending.reference
            let confirmed = existing.pending.confirmedAmountKobo
            current.pending = slot
            // The answer is in memory even if writing it down failed.
            if slot.reference == nil, reference != nil {
                current.pending.reference = reference
                current.pending.confirmedAmountKobo = confirmed
            }
        } else {
            current = Held(pending: slot, phase: .unsettled(.interrupted))
        }
        if current.pending.reference != nil {
            current.phase = .started
        } else if inFlight.contains(slot.key) {
            current.phase = .sending
        } else if case .sending = current.phase {
            current.phase = .unsettled(.interrupted)
        }
        held = current
        screen = .attempt(Self.attemptScreen(for: current))
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

    private struct SendContext {
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

    private func applyOutcome(_ result: Result<StartedCheckout, APIError>, context: SendContext) {
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
            guard onScreen, var current = held else { return }
            current.pending.reference = started.reference
            current.pending.confirmedAmountKobo = started.amountKobo
            current.phase = .started
            held = current
            screen = .attempt(Self.attemptScreen(for: current))

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
            guard onScreen, var current = held else { return }
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

    // MARK: - The session

    /// Whether any attempt made under a session is stored, for the sign-out confirmation. Storage that
    /// cannot be listed counts as "yes": the safe answer is to ask.
    public var hasSessionAttempts: Bool {
        guard let slots = try? store.all() else { return true }
        return slots.contains { slot in
            switch slot {
            case .pending(let pending): pending.owner.isSession
            case .unreadable: true
            }
        }
    }

    /// React to a change in who is signed in; `AttemptOwner` states the rule.
    public func sessionDidChange(_ change: SessionChange) {
        switch change {
        case .ended:
            // An involuntary end says nothing about who is holding the phone: nothing is forgotten.
            return

        case .signedOutByChoice:
            confirmedUserID = nil
            runCleanup(.allSession)
            resetOpenScreen()

        case .resolved(let user):
            let previous = confirmedUserID
            confirmedUserID = user.id
            runCleanup(.foreign(user: user.id, dropUnconfirmed: false))
            adoptUnconfirmed(by: user.id)
            if let previous, previous != user.id {
                resetOpenScreen()
            }

        case .signedIn(let user):
            confirmedUserID = user.id
            runCleanup(.foreign(user: user.id, dropUnconfirmed: true))
            resetOpenScreen()
        }
    }

    /// Empty everything that belongs to the person who was here, and show the open link again as it looks
    /// to whoever is here now.
    private func resetOpenScreen() {
        form.reset()
        held = nil
        lookupCarry = nil
        inFlight = []
        guard let code = openCode else {
            screen = .idle
            return
        }
        lookupGeneration += 1
        lookupTask?.cancel()
        present(code)
    }

    /// Remove what `cleanup` names. A removal that fails is remembered and hides what it could not
    /// remove (`present`) until a later attempt succeeds; it is never swallowed.
    private func runCleanup(_ cleanup: Cleanup? = nil) {
        let target: Cleanup
        if let cleanup {
            // A sign-out supersedes any narrower cleanup still waiting.
            target = (pendingCleanup == .allSession || cleanup == .allSession) ? .allSession : cleanup
        } else if let waiting = pendingCleanup {
            target = waiting
        } else {
            return
        }

        var complete = true
        let slots: [PendingSlot]
        do throws(PendingStoreError) {
            slots = try store.all()
        } catch {
            pendingCleanup = target
            return
        }
        for slot in slots {
            switch slot {
            case .pending(let pending) where target.removes(pending.owner):
                do throws(PendingStoreError) {
                    try store.remove(pending.request.code)
                } catch {
                    complete = false
                }
            case .unreadable(let slotID):
                // Cannot tell whose it is. Sign-out clears it; other cleanups leave it for the block
                // that offers the person a way to remove it.
                if target == .allSession {
                    do throws(PendingStoreError) {
                        try store.remove(slotID: slotID)
                    } catch {
                        complete = false
                    }
                }
            case .pending:
                break
            }
        }
        pendingCleanup = complete ? nil : target
    }

    /// The check confirmed whose session this is: attempts made before it finished get their owner.
    private func adoptUnconfirmed(by userID: String) {
        guard let slots = try? store.all() else { return }
        for case .pending(var pending) in slots where pending.owner == .session(userID: nil) {
            pending.owner = .session(userID: userID)
            try? store.save(pending)
            if held?.pending.key == pending.key { held?.pending.owner = pending.owner }
        }
    }
}
