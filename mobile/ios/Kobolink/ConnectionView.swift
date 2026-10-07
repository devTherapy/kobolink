import KobolinkKit
import SwiftUI

/// The first screen: which server this build talks to, and whether it
/// answers. A real screen for later rows to replace; for now it proves the
/// generated client reaches the API. It lives inside `RootView`'s navigation stack.
struct ConnectionView: View {
    let host: String
    @State private var checker: ConnectionChecker

    init(host: String, checker: ConnectionChecker) {
        self.host = host
        self._checker = State(initialValue: checker)
    }

    var body: some View {
        List {
            Section {
                LabeledContent("Server", value: host)
                StatusRow(status: checker.status)
            } footer: {
                Text("Kobolink checks that its server is up before you rely on it.")
            }

            Section {
                Button("Check again") {
                    Task { await checker.check() }
                }
                .disabled(checker.status == .checking)
            }
        }
        .navigationTitle("Kobolink")
        .refreshable { await checker.check() }
        .task { await checker.check() }
    }
}

private struct StatusRow: View {
    let status: ConnectionChecker.Status

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            icon
                .frame(minWidth: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                if let detail {
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var icon: some View {
        switch status {
        case .checking:
            ProgressView()
        case .reachable:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint)
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.secondary)
        }
    }

    private var title: String {
        switch status {
        case .checking: "Checking the server"
        case .reachable: "Server is reachable"
        case .failed: "Can't connect"
        }
    }

    private var detail: String? {
        if case .failed(let message) = status { message } else { nil }
    }
}

/// Shown instead of a crash when the build has no usable API base URL.
struct MisconfiguredView: View {
    let problem: APIConfiguration.Problem

    var body: some View {
        ContentUnavailableView {
            Label("Kobolink isn't set up", systemImage: "gearshape.2")
        } description: {
            Text(explanation)
        }
    }

    private var explanation: String {
        switch problem {
        case .missing, .unresolved:
            "This build has no server address. Set KOBOLINK_API_BASE_URL in Config/*.xcconfig."
        case .invalid(let value):
            "\"\(value)\" is not a server address. Use an http or https URL."
        case .insecure:
            "This build only talks to servers over https. Set an https KOBOLINK_API_BASE_URL."
        case .hasPath:
            "The server address must be just a host (for example https://pay.folusayo.com), with no path."
        }
    }
}

#Preview("Reachable") {
    NavigationStack {
        ConnectionView(host: "pay.folusayo.com", checker: ConnectionChecker(api: PreviewHealth(result: nil)))
    }
}

#Preview("Unreachable") {
    NavigationStack {
        ConnectionView(
            host: "localhost",
            checker: ConnectionChecker(api: PreviewHealth(result: .unreachable(.cannotConnectToHost)))
        )
    }
}

private struct PreviewHealth: HealthChecking {
    let result: APIError?
    func health() async throws(APIError) {
        if let result { throw result }
    }
}
