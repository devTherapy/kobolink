import KobolinkKit
import SwiftUI

/// Where a deep link lands: the checkout for a link, or a plain statement for a URL that is not one.
struct LinkLandingView: View {
    let destination: LinkDestination
    let home: RootView.Home
    let onDone: () -> Void

    var body: some View {
        switch destination {
        case .link(let code):
            switch home {
            case .ready(_, _, _, let checkout):
                CheckoutView(code: code, checkout: checkout, onDone: onDone)
            case .misconfigured(let problem):
                MisconfiguredView(problem: problem)
                    .navigationTitle("Payment link")
                    .navigationBarTitleDisplayMode(.inline)
            }
        case .invalid(let received):
            InvalidLinkView(received: received)
                .navigationTitle("Payment link")
                .navigationBarTitleDisplayMode(.inline)
        }
    }
}

private struct InvalidLinkView: View {
    let received: String

    var body: some View {
        ContentUnavailableView {
            Label("This link can't be opened", systemImage: "exclamationmark.triangle")
        } description: {
            VStack(spacing: 12) {
                Text("Kobolink doesn't recognise it. Ask whoever sent it for a new link.")
                Text(received)
                    .font(.footnote.monospaced())
                    .lineLimit(3)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }
        }
    }
}

#Preview("Invalid") {
    NavigationStack {
        LinkLandingView(destination: .invalid("kobolink://l/not-a-code"), home: .misconfigured(.missing), onDone: {})
    }
}
