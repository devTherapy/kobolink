import KobolinkKit
import SwiftUI

// The screens after Send is tapped. Each one says what happened, whether money moved (always its own line, in the
// same place), and what to do next. The recipient is always the PHONE NUMBER; a name from a scanned code appears
// only under it, labelled as unverified.

/// One button under a notice.
private struct ResultAction: Identifiable {
    enum Kind { case prominent, plain, destructive }
    let title: String
    let kind: Kind
    let run: () -> Void
    var id: String { title }

    init(_ title: String, _ kind: Kind, _ run: @escaping () -> Void) {
        self.title = title
        self.kind = kind
        self.run = run
    }
}

/// A full-screen statement: a symbol, a heading, the facts, the money line and the next step.
private struct ResultLayout<Facts: View>: View {
    let symbol: String
    let symbolStyle: Color
    let heading: String
    var body_: String?
    var moneyLine: String?
    var nextStep: String?
    let actions: [ResultAction]
    @ViewBuilder let facts: Facts

    @AccessibilityFocusState private var headingFocused: Bool

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Image(systemName: symbol)
                    .font(.largeTitle)
                    .imageScale(.large)
                    .foregroundStyle(symbolStyle)
                    .accessibilityHidden(true)

                VStack(spacing: 6) {
                    Text(heading)
                        .font(.title2.bold())
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityFocused($headingFocused)
                    if let body_ {
                        Text(body_).font(.body)
                    }
                }
                .multilineTextAlignment(.center)

                facts

                if let moneyLine {
                    Text(moneyLine)
                        .font(.callout.weight(.semibold))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 12))
                }

                if let nextStep {
                    Text(nextStep)
                        .font(.subheadline)
                        .multilineTextAlignment(.center)
                }

                VStack(spacing: 8) {
                    ForEach(actions) { action in
                        button(for: action)
                    }
                }
                .controlSize(.large)
                .padding(.top, 4)
            }
            .padding()
            .frame(maxWidth: .infinity)
        }
        .background(Color(.systemGroupedBackground))
        .onAppear { headingFocused = true }
    }

    @ViewBuilder private func button(for action: ResultAction) -> some View {
        switch action.kind {
        case .prominent:
            Button(action: action.run) {
                Text(action.title).fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .foregroundStyle(Color(.systemBackground))
        case .plain:
            Button(action: action.run) {
                Text(action.title).frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
        case .destructive:
            Button(role: .destructive, action: action.run) {
                Text(action.title).frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
        }
    }
}

extension ResultLayout {
    init(
        symbol: String, symbolStyle: Color, heading: String, body: String? = nil, moneyLine: String? = nil, nextStep: String? = nil,
        actions: [ResultAction], @ViewBuilder facts: () -> Facts
    ) {
        self.symbol = symbol
        self.symbolStyle = symbolStyle
        self.heading = heading
        self.body_ = body
        self.moneyLine = moneyLine
        self.nextStep = nextStep
        self.actions = actions
        self.facts = facts()
    }
}

/// What is being paid, to whom: the amount, the NUMBER, the unverified QR name if there is one, the note.
private struct PaymentFacts: View {
    let attempt: TransferAttempt

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            row("Amount", WalletCopy.amount(attempt), spoken: Kobo.spokenNaira(attempt.instruction.amountKobo))
            row("To", WalletCopy.recipient(attempt), spoken: NigerianPhone.spoken(attempt.instruction.toPhone))
            if let name = attempt.payeeName {
                VStack(alignment: .leading, spacing: 2) {
                    Text(WalletCopy.qrNameLabel).font(.footnote).foregroundStyle(Color.secondaryText)
                    Text(name).font(.subheadline).foregroundStyle(Color.secondaryText)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(WalletCopy.qrNameLabel): \(name)")
            }
            if let note = attempt.instruction.note {
                row("Note", note, spoken: note)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    private func row(_ label: String, _ value: String, spoken: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.footnote).foregroundStyle(Color.secondaryText)
            Text(value).font(.body.weight(.semibold)).monospacedDigit()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(spoken)")
    }
}

// MARK: - Sending

struct SendingView: View {
    let attempt: TransferAttempt
    let replay: Bool

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                ProgressView()
                    .controlSize(.large)
                    .padding(.top, 24)
                Text(WalletCopy.sendingHeading)
                    .font(.title2.bold())
                    .accessibilityAddTraits(.isHeader)
                PaymentFacts(attempt: attempt)
                Text(replay ? WalletCopy.replayingNextStep : WalletCopy.sendingNextStep)
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
            }
            .padding()
            .frame(maxWidth: .infinity)
        }
        .background(Color(.systemGroupedBackground))
        .accessibilityElement(children: .contain)
        .onAppear { AccessibilityNotification.Announcement(WalletCopy.sendingHeading).post() }
    }
}

// MARK: - Sent

struct SentView: View {
    let wallet: WalletController
    let attempt: TransferAttempt
    let receipt: TransferReceipt
    let replayed: Bool

    var body: some View {
        ResultLayout(
            symbol: "checkmark.circle.fill", symbolStyle: Color.paymentSuccess,
            heading: replayed ? "It went through" : "Sent",
            body: "\(WalletCopy.summary(attempt)) went through.",
            moneyLine: WalletCopy.balanceLine(receipt, replayed: replayed),
            actions: [
                ResultAction("Done", .prominent) { wallet.isSendPresented = false },
                ResultAction("Send Another", .plain) { wallet.openSend() },
            ]
        ) {
            PaymentFacts(attempt: attempt)
        }
    }
}

// MARK: - Failed

struct FailedView: View {
    let wallet: WalletController
    let attempt: TransferAttempt
    let failure: TransferFailure
    @State private var confirmingDiscard = false

    private var send: SendController { wallet.send }

    var body: some View {
        let text = WalletCopy.failure(failure, attempt: attempt)
        ResultLayout(
            symbol: failure.isSettled ? "xmark.circle.fill" : "exclamationmark.triangle.fill",
            symbolStyle: failure.isSettled ? Color.errorText : Color.warningText,
            heading: text.heading, body: text.body, moneyLine: text.moneyLine, nextStep: text.nextStep,
            actions: actions
        ) {
            VStack(spacing: 12) {
                PaymentFacts(attempt: attempt)
                if send.discardFailed {
                    Label(WalletCopy.discardFailed, systemImage: "exclamationmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(Color.errorText)
                }
            }
        }
        .confirmationDialog(WalletCopy.discardTitle, isPresented: $confirmingDiscard, titleVisibility: .visible) {
            Button("I Checked: It Didn't Go Through", role: .destructive, action: send.discardUnresolved)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(WalletCopy.discardMessage(attempt))
        }
        .onAppear { AccessibilityNotification.Announcement(text.heading + ". " + text.moneyLine).post() }
    }

    private var actions: [ResultAction] {
        if !failure.isSettled {
            // Unknown outcome: the same request under the same key, or the person's own word that it did not
            // happen. Editing is not offered: a changed request under the old key would be refused, and under a
            // new one could pay twice.
            return [
                ResultAction("Try Again", .prominent, send.tryAgain),
                ResultAction("Check Recent Activity", .plain) { wallet.isSendPresented = false },
                ResultAction("I Checked: It Didn't Go Through", .destructive) { confirmingDiscard = true },
            ]
        }
        if case .notRecorded = failure {
            return [
                ResultAction("Try Again", .prominent, send.tryAgain),
                ResultAction("Close", .plain) { wallet.isSendPresented = false },
            ]
        }
        return [
            ResultAction("Edit Details", .prominent, send.editDetails),
            ResultAction("Close", .plain) { wallet.isSendPresented = false },
        ]
    }
}

// MARK: - Blocked

struct BlockedView: View {
    let send: SendController
    let block: SendBlock
    let close: () -> Void
    @State private var confirmingForget = false

    var body: some View {
        let text = WalletCopy.blocked(block)
        ResultLayout(
            symbol: "lock.trianglebadge.exclamationmark.fill", symbolStyle: Color.warningText,
            heading: text.heading, body: text.body, moneyLine: text.moneyLine, nextStep: text.nextStep,
            actions: actions
        ) {
            EmptyView()
        }
        .confirmationDialog(WalletCopy.forgetTitle, isPresented: $confirmingForget, titleVisibility: .visible) {
            Button("Forget Saved Payments", role: .destructive, action: send.forgetSavedPayments)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(WalletCopy.forgetMessage)
        }
    }

    private var actions: [ResultAction] {
        var actions = [ResultAction("Try Again", .prominent, send.retryBlocked)]
        switch block {
        case .undecodable, .obligationUnreadable, .resetFailed:
            actions.append(ResultAction("Forget Saved Payments", .destructive) { confirmingForget = true })
        case .unreadable, .cannotClear:
            break
        }
        actions.append(ResultAction("Close", .plain, close))
        return actions
    }
}
