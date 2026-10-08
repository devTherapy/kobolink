import Foundation
import Observation

/// Every decision the send flow makes, as plain Swift over `WalletServing` and `PendingTransferStore`, so all of it
/// runs in unit tests. The screen only renders `screen` and `form` and forwards taps.
///
/// ## One idempotency key per payment, written down before it is used
/// A payment is one `TransferAttempt`. Its key is made when the person taps Send on the review step and is written
/// to the Keychain BEFORE the request leaves; if it cannot be written, nothing is sent (`TransferFailure.notRecorded`,
/// the one place "No money was taken" is a fact about the tap: there is no earlier send).
///
/// - A retry resends the IDENTICAL request under the IDENTICAL key (`tryAgain`), and writes nothing first, so a
///   storage failure cannot turn a replay into a new payment. A key is never minted while a payment of unknown
///   outcome exists: the form is not even reachable then (`begin` shows the unfinished one), so its request cannot
///   be edited under the old key.
/// - The attempt is removed only by: a success; a refusal the server stores under the key (`TransferVerdict`); the
///   first-send validation refusal; the person's confirmed `discardUnresolved`; and a sign-out (gated, below).
///   Nothing else clears it: not a 401, not a 429, not a 5xx, not a dropped connection, not an unreadable reply, not
///   `idempotency_mismatch`, not a validation error on a retry, not a storage failure.
/// - No silent retry: one `transfer` call per send, and `KobolinkAPIClient` never resends a POST.
///
/// ## Latest wins
/// A reply is applied to the SCREEN and the HOME only while the screen still shows its own attempt (`apply`). A
/// sign-out or a different user empties the screen (`forgetMemory`), so a late reply reaches neither it nor the home
/// (a previous user's balance is never written back). Its effect on STORAGE is by identity: it only updates or
/// removes the slot that still holds its own key, so a late answer cannot bring back an attempt that sign-out
/// removed. The same person coming back after an involuntary end finds the attempt on screen again, and the answer
/// lands instead of leaving a spinner.
///
/// ## Sign-out
/// See `prepareSignOut`. A sign-out is the one thing that removes an unresolved payment from the device, it is gated
/// by a persisted `SignOutObligation`, and it is confirmed by the person first. An involuntary end (a 401) removes
/// nothing, and the same user signing in again gets the payment back.
@MainActor
@Observable
public final class SendController {
    public private(set) var screen: SendScreen = .idle
    public let form = SendForm()
    /// "I checked" was confirmed and storage would not let go of the record: nothing changed.
    public private(set) var discardFailed = false
    /// The payment whose outcome is not known, if any. The home flags it, and Send opens it before anything new.
    public private(set) var unresolved: TransferAttempt?

    @ObservationIgnored private let service: any WalletServing
    @ObservationIgnored private let store: any PendingTransferStore
    @ObservationIgnored private let makeKey: @Sendable () -> String
    @ObservationIgnored private let now: @Sendable () -> Date

    /// Told when a payment was posted: the receipt, and whether it is a replay's stored original.
    @ObservationIgnored public var onReceipt: (@MainActor (TransferReceipt, _ replayed: Bool) -> Void)?
    /// Told when the server said the wallet holds too little: the balance on screen was wrong, look again.
    @ObservationIgnored public var onInsufficientFunds: (@MainActor () -> Void)?

    @ObservationIgnored private var boundUserID: String?
    /// Keys whose request is in flight now.
    @ObservationIgnored private var inFlight: Set<String> = []
    /// What a sign-out still owes the device. Written BEFORE the sign-out, read again by a new process BEFORE anything
    /// else happens, and hides what it names until the removal succeeds.
    @ObservationIgnored private var owed: SignOutObligation?
    @ObservationIgnored private var owedBeforePrepare: SignOutObligation?
    @ObservationIgnored private var obligationLoaded = false
    /// Set when a sign-out could not be prepared in time: every saved payment is hidden until it can be.
    @ObservationIgnored private var hideAll = false

    public init(
        service: any WalletServing,
        store: any PendingTransferStore,
        makeKey: @escaping @Sendable () -> String = IdempotencyKey.make,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.service = service
        self.store = store
        self.makeKey = makeKey
        self.now = now
    }

    // MARK: - Opening and closing

    /// The person opened Send (or Scan to Pay). If a payment of unknown outcome exists THAT is what they see, with
    /// its key and request intact; otherwise a fresh form, or the camera.
    public func begin(scanning: Bool) {
        guard boundUserID != nil else { return }
        if case .blocked = screen { restore() }
        switch screen {
        case .blocked, .sending:
            return
        case .failed(_, let failure) where !failure.isSettled:
            return
        default:
            form.reset()
            discardFailed = false
            screen = scanning ? .scan : .form
        }
    }

    /// The sheet went away. Whatever the person had typed goes with it; a payment of unknown outcome stays, and so
    /// does a request that is still in the air.
    public func sheetClosed() {
        switch screen {
        case .sending, .blocked:
            return
        case .failed(_, let failure) where !failure.isSettled:
            return
        default:
            form.reset()
            discardFailed = false
            screen = .idle
        }
    }

    // MARK: - The form

    /// "Review": check the form, then show what is about to be sent. Nothing is sent and no key exists yet.
    public func review() {
        guard case .form = screen else { return }
        switch SendValidation.validate(phone: form.phone, amountText: form.amountText, note: form.note) {
        case .invalid(let errors):
            form.errors = errors
        case .valid(let instruction):
            form.errors = [:]
            screen = .confirm(TransferDraft(instruction: instruction, payeeName: form.scannedName))
        }
    }

    /// Back to the form with what was typed: from the review step, or after a refusal that proves no money moved.
    public func editDetails() {
        switch screen {
        case .confirm:
            screen = .form
        case .failed(_, let failure) where failure.isSettled:
            screen = .form
        default:
            return
        }
    }

    /// The camera found a payee: the form opens filled in. The name is kept beside the number it came with, as
    /// unverified.
    public func useScanned(_ payee: ScannedPayee) {
        guard case .scan = screen else { return }
        form.fill(from: payee)
        screen = .form
    }

    /// "Enter Details Instead", from the camera.
    public func enterDetails() {
        guard case .scan = screen else { return }
        screen = .form
    }

    /// The form's "Scan QR Code" button.
    public func startScanning() {
        guard case .form = screen else { return }
        screen = .scan
    }

    // MARK: - Sending

    /// "Send" on the review step. One tap, one request: it starts only from `.confirm` and leaves it in the same
    /// step, so a second tap finds nothing to do.
    public func confirm() {
        guard case .confirm(let draft) = screen, let userID = boundUserID else { return }
        let attempt = TransferAttempt(
            key: makeKey(), userID: userID, instruction: draft.instruction, payeeName: draft.payeeName, createdAt: now())

        // Write it down BEFORE the request leaves. If the process dies mid-flight the next one knows which key to
        // retry under. If it cannot be written, nothing is sent: an unrecorded payment could be made twice.
        do throws(PendingStoreError) {
            try store.save(attempt)
        } catch {
            screen = .failed(attempt, .notRecorded)
            return
        }
        unresolved = attempt
        screen = .sending(attempt, replay: false)
        send(attempt, firstEverSend: true)
    }

    /// "Try Again" on a payment of unknown outcome: the SAME request under the SAME key. Nothing is written first
    /// (the key is already stored), so a storage failure cannot turn a replay into a new payment, and nothing the
    /// server says about this replay alone can end the attempt.
    public func tryAgain() {
        switch screen {
        case .failed(let attempt, let failure) where !failure.isSettled:
            guard !inFlight.contains(attempt.key) else { return }
            screen = .sending(attempt, replay: true)
            send(attempt, firstEverSend: false)
        case .failed(let attempt, .notRecorded):
            // Nothing was ever sent or stored: back to the review step, where Send makes a fresh attempt.
            screen = .confirm(TransferDraft(instruction: attempt.instruction, payeeName: attempt.payeeName))
        default:
            return
        }
    }

    /// "I checked: it didn't go through", after the person confirmed. The only way to drop a payment of unknown
    /// outcome besides signing out. If storage will not let go NOTHING changes and the screen says so: forgetting
    /// it only in memory would bring it back after a restart.
    public func discardUnresolved() {
        guard case .failed(let attempt, let failure) = screen, !failure.isSettled, !inFlight.contains(attempt.key) else { return }
        do throws(PendingStoreError) {
            if let stored = try store.load(userID: attempt.userID), stored.key == attempt.key {
                try store.remove(userID: attempt.userID)
            }
        } catch {
            discardFailed = true
            return
        }
        discardFailed = false
        unresolved = nil
        form.reset()
        screen = .form
    }

    private func send(_ attempt: TransferAttempt, firstEverSend: Bool) {
        inFlight.insert(attempt.key)
        let service = self.service
        // Unstructured on purpose: leaving the screen must not cancel a payment request half way, because then the
        // answer would be lost along with the screen. Whether the answer reaches the SCREEN is `apply`'s decision.
        Task { [weak self] in
            let result: Result<TransferReceipt, APIError>
            do throws(APIError) {
                result = .success(try await service.transfer(attempt.instruction, idempotencyKey: attempt.key))
            } catch {
                result = .failure(error)
            }
            self?.apply(result, attempt: attempt, firstEverSend: firstEverSend)
        }
    }

    func apply(_ result: Result<TransferReceipt, APIError>, attempt: TransferAttempt, firstEverSend: Bool) {
        inFlight.remove(attempt.key)
        let verdict = TransferVerdict.of(result, instruction: attempt.instruction, firstEverSend: firstEverSend)
        // Does the screen still show THIS payment? After a sign-out or a different user the screen was emptied and
        // shows nothing of it, so the answer reaches neither the screen nor the home. When the same person is
        // back (an involuntary end, then a sign-in) the screen shows it again, and the answer lands.
        let showing = screen.unresolvedAttempt?.key == attempt.key

        switch verdict {
        case .sent(let receipt):
            removeSlot(for: attempt)
            if unresolved?.key == attempt.key { unresolved = nil }
            guard showing else { return }
            screen = .sent(attempt, receipt, replayed: !firstEverSend)
            onReceipt?(receipt, !firstEverSend)

        case .settled(let failure):
            removeSlot(for: attempt)
            if unresolved?.key == attempt.key { unresolved = nil }
            guard showing else { return }
            if case .invalidDetails(_, let fields) = failure { form.errors = fields }
            screen = .failed(attempt, failure)
            if case .insufficientFunds = failure { onInsufficientFunds?() }

        case .unsettled(let failure):
            // The attempt and its key stay, whoever is looking. A late "could not confirm" never takes back an
            // answer that has already arrived.
            guard showing else { return }
            screen = .failed(attempt, failure)
        }
    }

    /// Remove the attempt's slot if it still holds this attempt. One retry, since nobody is told about it: a slot
    /// that stays only brings back an interrupted attempt whose replay returns the same answer.
    private func removeSlot(for attempt: TransferAttempt) {
        func once() -> Bool {
            do throws(PendingStoreError) {
                guard let stored = try store.load(userID: attempt.userID), stored.key == attempt.key else { return true }
                try store.remove(userID: attempt.userID)
                return true
            } catch {
                return false
            }
        }
        if !once() { _ = once() }
    }

    // MARK: - The session

    /// Whether any unfinished payment is saved on this device, for the sign-out confirmation. Storage that cannot be
    /// listed counts as "yes": the safe answer is to ask.
    public var hasSavedPayments: Bool {
        guard let slots = try? store.all() else { return true }
        return !slots.isEmpty
    }

    /// Asked by the session BEFORE it signs the person out. It writes down what the sign-out owes (every saved
    /// payment and unreadable slot on the device, by slot and key) and returns `true` only when that is safely
    /// stored, or when nothing is owed. `false` means the sign-out must not happen: a sign-out whose clearing could
    /// be forgotten by a restart would show this person's payment to whoever holds the phone, or lose it silently.
    public func prepareSignOut() -> Bool {
        guard loadObligationOnce() == .ok else { return false }
        let slots: [TransferSlot]
        do throws(PendingStoreError) {
            slots = try store.all()
        } catch {
            return false
        }
        var entries = owed?.entries ?? []
        for slot in slots {
            switch slot {
            case .pending(let attempt): entries.append(.init(code: attempt.userID, key: attempt.key))
            case .unreadable(let slotID): entries.append(.init(code: slotID, key: nil))
            }
        }
        var seen = Set<SignOutObligation.Entry>()
        let unique = entries.filter { seen.insert($0).inserted }
        guard !unique.isEmpty else {
            hideAll = false
            return true
        }
        let obligation = SignOutObligation(entries: unique)
        do throws(PendingStoreError) {
            try store.saveObligation(obligation)
        } catch {
            return false
        }
        owedBeforePrepare = owed
        owed = obligation
        hideAll = false
        return true
    }

    /// The sign-out this obligation was written for did not go ahead (another part of the app refused it). Take the
    /// record back to what it was, so a restart does not carry out a sign-out that never happened.
    public func cancelPreparedSignOut() {
        guard owed != owedBeforePrepare else { return }
        let previous = owedBeforePrepare
        do throws(PendingStoreError) {
            if let previous { try store.saveObligation(previous) } else { try store.clearObligation() }
        } catch {
            return
        }
        owed = previous
    }

    /// React to a change in who is signed in.
    public func sessionDidChange(_ change: SessionChange) {
        switch change {
        case .ended:
            // An involuntary end says nothing about who is holding the phone: nothing is forgotten, and the same
            // user signing in again gets the payment back.
            return

        case .signedOutByChoice:
            boundUserID = nil
            // The session asked first (`prepareSignOut`), so this is normally a repeat. If it cannot be made safe
            // now, every saved payment is hidden until it can be.
            if !prepareSignOut() { hideAll = true }
            runOwed()
            forgetMemory()

        case .resolved(let user), .signedIn(let user):
            bind(user.id)
        }
    }

    /// `userID` is who is signed in. A different person from the one who was here empties everything in memory first.
    func bind(_ userID: String) {
        if let current = boundUserID, current != userID { forgetMemory() }
        boundUserID = userID
        restore()
    }

    /// Everything of the person who was here, gone from memory. Storage is a separate matter.
    private func forgetMemory() {
        form.reset()
        screen = .idle
        unresolved = nil
        discardFailed = false
        // `inFlight` is NOT cleared: a request still in the air is still in the air, and a second one for the same
        // key cannot be started on top of it.
    }

    /// Show what the device remembers for the bound user: a payment of unknown outcome, or a block.
    private func restore() {
        guard let userID = boundUserID else { return }
        // What a previous process owed comes first: until it is known, no slot may be shown.
        switch loadObligationOnce() {
        case .ok:
            break
        case .unavailable:
            unresolved = nil
            screen = .blocked(.unreadable)
            return
        case .undecodable:
            unresolved = nil
            screen = .blocked(.obligationUnreadable)
            return
        }
        runOwed()

        let slot: TransferAttempt?
        do throws(PendingStoreError) {
            slot = try store.load(userID: userID)
        } catch {
            unresolved = nil
            screen = .blocked(error.kind == .undecodable ? .undecodable : .unreadable)
            return
        }

        guard let slot else {
            if case .blocked = screen { screen = .idle }
            if let held = unresolved, !inFlight.contains(held.key) {
                unresolved = nil
                if screen.unresolvedAttempt?.key == held.key { screen = .idle }
            }
            return
        }
        if isHidden(slot) {
            unresolved = nil
            screen = .blocked(.cannotClear)
            return
        }

        switch screen {
        case .sending(let shown, _) where shown.key == slot.key:
            unresolved = slot
            return
        case .failed(let shown, let failure) where shown.key == slot.key && !failure.isSettled:
            unresolved = slot
            return
        case .sent(let shown, _, _) where shown.key == slot.key:
            // Posted, and the slot could not be removed: the screen is right. A restart would offer "Try Again",
            // whose replay returns this same success.
            return
        default:
            break
        }
        unresolved = slot
        screen = inFlight.contains(slot.key) ? .sending(slot, replay: true) : .failed(slot, .interrupted)
    }

    /// "Try Again" on a block: look at storage again.
    public func retryBlocked() {
        guard case .blocked = screen else { return }
        restore()
    }

    // MARK: - What a sign-out owes

    private enum ObligationRead { case ok, unavailable, undecodable }

    /// Reads what a previous process owed. A throw is "could not find out", and then no slot is shown and nothing is
    /// saved: guessing "nothing owed" could show a signed-out person's payment, or overwrite the record.
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

    /// Is this payment one a sign-out owes the removal of (or one hidden because a sign-out could not be prepared)?
    private func isHidden(_ attempt: TransferAttempt) -> Bool {
        hideAll || owed?.contains(code: attempt.userID, key: attempt.key) == true
    }

    /// Remove what a sign-out owes. A removal that fails leaves the obligation in place (it keeps hiding what it
    /// names); it is never swallowed.
    private func runOwed() {
        guard let current = owed else { return }
        let slots: [TransferSlot]
        do throws(PendingStoreError) {
            slots = try store.all()
        } catch {
            return
        }
        var complete = true
        for slot in slots {
            switch slot {
            case .pending(let attempt) where current.contains(code: attempt.userID, key: attempt.key):
                do throws(PendingStoreError) {
                    try store.remove(userID: attempt.userID)
                    inFlight.remove(attempt.key)
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
        owedBeforePrepare = nil
        // If the marker cannot be taken back it names attempts that are gone (keys are never reused), so the next
        // process finds nothing to remove and tries again.
        try? store.clearObligation()
    }

    /// The safe exit when a saved payment, or the record of what a sign-out owes, cannot be read: forget EVERY
    /// payment saved on this iPhone and the record itself, after the person confirmed ("If you already sent it,
    /// check Recent activity first"). If storage will not let go, nothing changes and the screen says so.
    public func forgetSavedPayments() {
        guard case .blocked(let block) = screen, block == .undecodable || block == .obligationUnreadable || block == .resetFailed
        else { return }
        do throws(PendingStoreError) {
            for slot in try store.all() {
                switch slot {
                case .pending(let attempt): try store.remove(userID: attempt.userID)
                case .unreadable(let slotID): try store.remove(slotID: slotID)
                }
            }
            try store.clearObligation()
        } catch {
            screen = .blocked(.resetFailed)
            return
        }
        owed = nil
        owedBeforePrepare = nil
        obligationLoaded = true
        hideAll = false
        inFlight = []
        unresolved = nil
        form.reset()
        screen = .idle
        restore()
    }
}
