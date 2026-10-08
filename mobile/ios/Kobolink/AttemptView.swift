import KobolinkKit
import SwiftUI

/// A payment that has no final answer yet: being sent, of unknown outcome, being confirmed, or confirmed-as-unknown.
/// Each is shown from the saved attempt, so it reads the same after a re-tap, Back, a relaunch and with no
/// connection. The controller decides which phase this is (`CheckoutController`); the view only says it and forwards taps.
///
/// How a payment ENDS (paid, failed, a link that could not take it) is `ResultView`.
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
            // The screen itself is replaced when the phase moves between kinds (the heading takes VoiceOver focus
            // on appearing); a change inside one kind ("still processing") has no new screen, so it is announced.
            .onChange(of: attempt.phase) { _, phase in
                if let line = Self.announcement(for: phase) { AccessibilityNotification.Announcement(line).post() }
            }
    }

    private static func announcement(for phase: AttemptPhase) -> String? {
        switch phase {
        case .verifying(stillProcessing: true): CheckoutCopy.processingHeading + ". " + CheckoutCopy.processingMoneyLine
        default: nil
        }
    }

    @ViewBuilder private var content: some View {
        switch attempt.phase {
        case .sending:
            NoticeScreen(
                symbol: "arrow.triangle.2.circlepath", symbolStyle: .accentColor,
                notice: Notice(
                    heading: CheckoutCopy.sendingHeading, body: nil,
                    moneyLine: CheckoutCopy.unsettledStatus, nextStep: CheckoutCopy.sendingNextStep),
                actions: [],
                detail: {
                    VStack(spacing: 12) {
                        amountLine
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
                actions: [NoticeAction("Try Again", .prominent, checkout.retry)] + escapes(prominent: false),
                detail: {
                    VStack(spacing: 12) {
                        amountLine
                        startOverError
                    }
                })

        case .verifying(let stillProcessing):
            // No buttons but Done: while the server is being asked there is nothing for the person to decide, and a
            // button that could start a second payment is not offered.
            NoticeScreen(
                symbol: stillProcessing ? "clock" : "arrow.triangle.2.circlepath", symbolStyle: .accentColor,
                notice: Notice(
                    heading: stillProcessing ? CheckoutCopy.processingHeading : CheckoutCopy.verifyingHeading, body: nil,
                    moneyLine: stillProcessing ? CheckoutCopy.processingMoneyLine : CheckoutCopy.verifyingMoneyLine,
                    nextStep: stillProcessing ? CheckoutCopy.processingNextStep : CheckoutCopy.verifyingNextStep),
                actions: [.init("Done", .plain, onDone)],
                detail: {
                    VStack(spacing: 12) {
                        amountLine
                        if let reference = attempt.reference { ReferenceBox(reference: reference) }
                        ProgressView().accessibilityLabel("Confirming payment")
                    }
                })

        case .unconfirmed(let reason):
            NoticeScreen(
                symbol: reason == .stillProcessing ? "clock" : "exclamationmark.triangle.fill",
                symbolStyle: reason == .stillProcessing ? Color.accentColor : Color.warningText,
                notice: Notice(
                    heading: CheckoutCopy.unconfirmedHeading(reason), body: CheckoutCopy.unconfirmedBody(reason),
                    moneyLine: CheckoutCopy.unconfirmedMoneyLine(reason),
                    nextStep: CheckoutCopy.unconfirmedNextStep(reason, merchant: attempt.merchantName)),
                actions: [NoticeAction("Check Again", .prominent, checkout.checkAgain)] + escapes(prominent: false),
                detail: {
                    VStack(spacing: 12) {
                        amountLine
                        if let reference = attempt.reference { ReferenceBox(reference: reference) }
                        startOverError
                    }
                })
        }
    }

    private var amountLine: some View {
        AmountLine(amountKobo: attempt.amountKobo, merchantName: attempt.merchantName, title: attempt.title)
    }

    /// Done, and the explicit, confirmed way out: forget this payment and start another.
    private func escapes(prominent: Bool) -> [NoticeAction] {
        [
            .init("Done", prominent ? .prominent : .plain, onDone),
            .init("Start a New Payment", .destructive) { confirmingStartOver = true },
        ]
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
