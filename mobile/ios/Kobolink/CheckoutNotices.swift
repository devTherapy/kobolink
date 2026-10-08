import KobolinkKit
import SwiftUI
import UIKit

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

/// What a payment is for, in the places every screen about it shows it: the amount, who it went to, and what for.
struct AmountLine: View {
    let amountKobo: Int
    let merchantName: String
    let title: String

    var body: some View {
        VStack(spacing: 2) {
            Text(Kobo.formatNaira(amountKobo))
                .font(.largeTitle.bold())
                .monospacedDigit()
            Text("to \(merchantName)")
                .font(.headline)
                .foregroundStyle(.secondary)
            Text(title)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .multilineTextAlignment(.center)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(Kobo.spokenNaira(amountKobo)) to \(merchantName). \(title)")
    }
}

/// A reference is quoted to a merchant, so it is monospaced, selectable, spelled out for VoiceOver, and can be copied.
/// There is no receipt to export: the reference is the receipt.
struct ReferenceBox: View {
    let reference: String
    @State private var copied = false

    var body: some View {
        VStack(spacing: 8) {
            VStack(spacing: 4) {
                Text("Reference").font(.footnote).foregroundStyle(.secondary)
                Text(reference)
                    .font(.title3.monospaced())
                    .textSelection(.enabled)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Reference \(CheckoutCopy.spelledOut(reference))")

            Button {
                UIPasteboard.general.string = reference
                copied = true
                AccessibilityNotification.Announcement(CheckoutCopy.referenceCopied).post()
            } label: {
                Label(copied ? "Copied" : CheckoutCopy.copyReference, systemImage: copied ? "checkmark" : "doc.on.doc")
                    .frame(minHeight: 44)
            }
            .buttonStyle(.bordered)
            .accessibilityLabel(CheckoutCopy.copyReference)
            .task(id: copied) {
                guard copied else { return }
                try? await Task.sleep(for: .seconds(2))
                copied = false
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
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
        .alert(isReset ? CheckoutCopy.resetTitle : CheckoutCopy.startOverTitle(), isPresented: $confirmingClear) {
            Button("Cancel", role: .cancel) {}
            if isReset {
                Button("Reset Checkout Data", role: .destructive) { checkout.resetCheckoutData() }
            } else {
                Button("Start a New Payment", role: .destructive) { checkout.startOver() }
            }
        } message: {
            Text(isReset
                ? CheckoutCopy.resetMessage
                : "This forgets the unreadable payment saved on this iPhone. If you already paid, check with the merchant first.")
        }
    }

    private var isReset: Bool { block == .obligationUnreadable || block == .resetFailed }

    private var actions: [NoticeAction] {
        var list: [NoticeAction] = [.init("Try Again", .prominent, checkout.reload)]
        if block == .undecodable || block == .undecodableClearFailed { list.append(.init("Start a New Payment", .destructive) { confirmingClear = true }) }
        if isReset { list.append(.init("Reset Checkout Data", .destructive) { confirmingClear = true }) }
        list.append(.init("Done", .plain, onDone))
        return list
    }
}
