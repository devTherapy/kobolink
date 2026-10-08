import KobolinkKit
import SwiftUI

/// How a payment ended, as the server decided it. Every state names what happened, says whether money moved, and
/// offers the next step (docs/DESIGN-SPEC.md), with a symbol AND words, never colour alone:
///
/// - paid: a green check (the one use of green in the app: it is a payment state), "Money moved."
/// - failed / no such payment: a red cross or a question mark, "No money moved."
/// - a link that could not take it (expired, switched off, already paid): the amber triangle the link screens use.
///
/// The screen is a replacement for the one that was waiting, so VoiceOver focus lands on its heading (`NoticeScreen`)
/// and the result is announced as well, because the person was waiting for exactly this and may have looked away.
struct ResultView: View {
    let checkout: CheckoutController
    let result: ResultScreen
    let onDone: () -> Void

    private var notice: Notice { CheckoutCopy.result(result) }

    var body: some View {
        NoticeScreen(
            symbol: symbol, symbolStyle: style, notice: notice, actions: actions,
            detail: {
                VStack(spacing: 12) {
                    AmountLine(amountKobo: result.amountKobo, merchantName: result.merchantName, title: result.title)
                    ReferenceBox(reference: result.reference)
                    if result.actionFailed {
                        Label(CheckoutCopy.startOverFailed, systemImage: "exclamationmark.circle.fill")
                            .font(.footnote)
                            .foregroundStyle(Color.errorText)
                            .multilineTextAlignment(.leading)
                    }
                }
            }
        )
        .onAppear {
            AccessibilityNotification.Announcement(notice.heading + ". " + notice.moneyLine).post()
        }
    }

    private var symbol: String {
        switch result.result {
        case .paid: "checkmark.circle.fill"
        case .declined: "xmark.circle.fill"
        case .linkExpired, .linkDisabled, .linkAlreadyPaid: "exclamationmark.triangle.fill"
        case .checkoutNotFound: "questionmark.circle"
        }
    }

    private var style: Color {
        switch result.result {
        case .paid: Color.successText
        case .declined: Color.errorText
        case .linkExpired, .linkDisabled, .linkAlreadyPaid: Color.warningText
        case .checkoutNotFound: Color.secondary
        }
    }

    /// Done is the way out of a payment that went through. One that did not has a next move: try again (a new
    /// payment, after the link is read afresh), or for a link that could not take it, look at the link again.
    private var actions: [NoticeAction] {
        switch result.result {
        case .paid:
            [.init("Done", .prominent, onDone)]
        case .declined, .checkoutNotFound:
            [.init("Try Again", .prominent, checkout.startOver), .init("Done", .plain, onDone)]
        case .linkExpired, .linkDisabled, .linkAlreadyPaid:
            [.init("Check Again", .prominent, checkout.startOver), .init("Done", .plain, onDone)]
        }
    }
}
