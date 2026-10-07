import KobolinkKit
import SwiftUI

/// Where a deep link lands. The real checkout is feature I3; until then this
/// shows which link was opened, and a clear state when the link is not one.
struct LinkLandingView: View {
    let destination: LinkDestination

    var body: some View {
        Group {
            switch destination {
            case .link(let code):
                LinkOpenedView(code: code)
            case .invalid(let received):
                InvalidLinkView(received: received)
            }
        }
        .navigationTitle("Payment link")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct LinkOpenedView: View {
    let code: LinkCode

    var body: some View {
        List {
            Section {
                LabeledContent("Link code") {
                    Text(code.value)
                        .font(.body.monospaced())
                        .textSelection(.enabled)
                        .speechSpellsOutCharacters()
                }
            } footer: {
                Text("This link opened in Kobolink. Paying from the app is coming in a later update.")
            }
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

#Preview("Link") {
    NavigationStack {
        LinkLandingView(destination: .link(LinkCode("aBcDeFgH")!))
    }
}

#Preview("Invalid") {
    NavigationStack {
        LinkLandingView(destination: .invalid("kobolink://l/not-a-code"))
    }
}
