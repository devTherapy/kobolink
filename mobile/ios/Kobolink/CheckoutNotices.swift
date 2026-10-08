import KobolinkKit
import SwiftUI

/// One button under a notice.
struct NoticeAction: Identifiable {
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

/// A full-screen statement: a symbol, what happened, what is and is not known about the money, and the
/// next step. Used for every state where the payer cannot pay, so each says the same things in the same
/// places (docs/DESIGN-SPEC.md: name what went wrong, say whether money moved, offer the next step).
struct NoticeScreen<Detail: View>: View {
    let symbol: String
    let symbolStyle: Color
    var eyebrow: String?
    var subtitle: String?
    let notice: Notice
    let actions: [NoticeAction]
    @ViewBuilder let detail: Detail

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
                    if let eyebrow {
                        Text(eyebrow).font(.subheadline).foregroundStyle(.secondary)
                    }
                    Text(notice.heading)
                        .font(.title2.bold())
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityFocused($headingFocused)
                    if let subtitle {
                        Text(subtitle).font(.headline).foregroundStyle(.secondary)
                    }
                    if let body = notice.body {
                        Text(body).font(.body)
                    }
                }
                .multilineTextAlignment(.center)

                detail

                Text(notice.moneyLine)
                    .font(.callout.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 12))

                Text(notice.nextStep)
                    .font(.subheadline)
                    .multilineTextAlignment(.center)

                VStack(spacing: 8) {
                    ForEach(actions) { action in
                        actionButton(action)
                    }
                }
                .controlSize(.large)
                .padding(.top, 4)
            }
            .padding()
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(Color(.systemGroupedBackground))
        .onAppear { headingFocused = true }
    }
}

extension NoticeScreen {
    /// 44pt tall at the smallest, growing with Dynamic Type. Prominent is the one brand-coloured action;
    /// its label takes the background colour so it reads in Dark Mode, where the tint is light.
    @ViewBuilder fileprivate func actionButton(_ action: NoticeAction) -> some View {
        let label = Text(action.title).fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: 44)
        switch action.kind {
        case .prominent:
            Button(action: action.run) { label }
                .buttonStyle(.borderedProminent)
                .foregroundStyle(Color(.systemBackground))
        case .plain:
            Button(action: action.run) { label }
                .buttonStyle(.bordered)
        case .destructive:
            Button(role: .destructive, action: action.run) { label.foregroundStyle(Color.errorText) }
                .buttonStyle(.borderless)
        }
    }
}

extension NoticeScreen where Detail == EmptyView {
    init(
        symbol: String, symbolStyle: Color, eyebrow: String? = nil, subtitle: String? = nil,
        notice: Notice, actions: [NoticeAction]
    ) {
        self.init(
            symbol: symbol, symbolStyle: symbolStyle, eyebrow: eyebrow, subtitle: subtitle, notice: notice,
            actions: actions, detail: { EmptyView() })
    }
}

// MARK: - A remembered payment

/// "Payment started", or a payment of unknown outcome. Both are shown from the saved attempt, so they
/// appear the same on a re-tap, after Back, after a relaunch and with no connection.
///
/// "Payment started" is the hand-off to feature I4: `initialize` answered with a reference, and `verify`
/// (which decides the outcome) is I4's. I4 replaces this body with the verify call and the result
/// states. Until then it says plainly that nothing has been confirmed.
struct AttemptView: View {
    let checkout: CheckoutController
    let attempt: AttemptScreen
    let onDone: () -> Void
    @State private var confirmingStartOver = false

    var body: some View {
        content
            .alert(CheckoutCopy.startOverTitle(), isPresented: $confirmingStartOver) {
                Button("Cancel", role: .cancel) {}
                Button("Start a New Payment", role: .destructive) { checkout.startOver() }
            } message: {
                Text(CheckoutCopy.startOverMessage(reference: attempt.reference, merchant: attempt.merchantName))
            }
            .onChange(of: attempt.phase) { _, phase in
                if case .unsettled = phase { AccessibilityNotification.Announcement(CheckoutCopy.unsettledHeading).post() }
            }
    }

    @ViewBuilder private var content: some View {
        switch attempt.phase {
        case .started:
            NoticeScreen(
                symbol: "clock", symbolStyle: .accentColor,
                notice: Notice(
                    heading: CheckoutCopy.startedHeading, body: nil,
                    moneyLine: CheckoutCopy.startedMoneyLine, nextStep: CheckoutCopy.startedNextStep),
                actions: actions(retry: false),
                detail: {
                    VStack(spacing: 12) {
                        AmountLine(attempt: attempt)
                        if let reference = attempt.reference { ReferenceBox(reference: reference) }
                        startOverError
                    }
                })

        case .sending:
            NoticeScreen(
                symbol: "arrow.triangle.2.circlepath", symbolStyle: .accentColor,
                notice: Notice(
                    heading: CheckoutCopy.sendingHeading, body: nil,
                    moneyLine: CheckoutCopy.unsettledStatus, nextStep: CheckoutCopy.sendingNextStep),
                actions: [],
                detail: {
                    VStack(spacing: 12) {
                        AmountLine(attempt: attempt)
                        ProgressView().accessibilityLabel("Starting payment")
                    }
                })

        case .unsettled(let reason):
            NoticeScreen(
                symbol: "exclamationmark.triangle.fill", symbolStyle: Color.warningText,
                notice: Notice(
                    heading: CheckoutCopy.unsettledHeading, body: CheckoutCopy.unsettledBody(reason),
                    moneyLine: CheckoutCopy.unsettledStatus,
                    nextStep: CheckoutCopy.unsettledNextStep(merchant: attempt.merchantName)),
                actions: actions(retry: true),
                detail: {
                    VStack(spacing: 12) {
                        AmountLine(attempt: attempt)
                        startOverError
                    }
                })
        }
    }

    private func actions(retry: Bool) -> [NoticeAction] {
        var list: [NoticeAction] = []
        if retry { list.append(.init("Try Again", .prominent, checkout.retry)) }
        list.append(.init("Done", retry ? .plain : .prominent, onDone))
        list.append(.init("Start a New Payment", .destructive) { confirmingStartOver = true })
        return list
    }

    @ViewBuilder private var startOverError: some View {
        if attempt.startOverFailed {
            Label(CheckoutCopy.startOverFailed, systemImage: "exclamationmark.circle.fill")
                .font(.footnote)
                .foregroundStyle(Color.errorText)
                .multilineTextAlignment(.leading)
        }
    }
}

private struct AmountLine: View {
    let attempt: AttemptScreen

    var body: some View {
        VStack(spacing: 2) {
            Text(Kobo.formatNaira(attempt.amountKobo))
                .font(.largeTitle.bold())
                .monospacedDigit()
            Text("to \(attempt.merchantName)")
                .font(.headline)
                .foregroundStyle(.secondary)
            Text(attempt.title)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .multilineTextAlignment(.center)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(Kobo.spokenNaira(attempt.amountKobo)) to \(attempt.merchantName). \(attempt.title)")
    }
}

/// A reference is quoted to a merchant, so it is monospaced, selectable, and spelled out for VoiceOver.
private struct ReferenceBox: View {
    let reference: String

    var body: some View {
        VStack(spacing: 4) {
            Text("Reference").font(.footnote).foregroundStyle(.secondary)
            Text(reference)
                .font(.title3.monospaced())
                .textSelection(.enabled)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Reference \(CheckoutCopy.spelledOut(reference))")
    }
}

// MARK: - Storage

/// Secure storage would not say, or would not let go. The link is not offered for payment: guessing
/// could send a second payment, or show someone else's.
struct StorageBlockedView: View {
    let block: StorageBlock
    let checkout: CheckoutController
    let onDone: () -> Void
    @State private var confirmingClear = false

    var body: some View {
        NoticeScreen(
            symbol: "lock.slash", symbolStyle: Color.warningText, notice: CheckoutCopy.storageBlocked(block),
            actions: actions
        )
        .alert(CheckoutCopy.startOverTitle(), isPresented: $confirmingClear) {
            Button("Cancel", role: .cancel) {}
            Button("Start a New Payment", role: .destructive) { checkout.startOver() }
        } message: {
            Text("This forgets the unreadable payment saved on this iPhone. If you already paid, check with the merchant first.")
        }
    }

    private var actions: [NoticeAction] {
        var list: [NoticeAction] = [.init("Try Again", .prominent, checkout.reload)]
        if block == .undecodable || block == .undecodableClearFailed { list.append(.init("Start a New Payment", .destructive) { confirmingClear = true }) }
        list.append(.init("Done", .plain, onDone))
        return list
    }
}
