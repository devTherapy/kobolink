import KobolinkKit
import SwiftUI

/// The root of the navigation stack: whichever screen the session state calls for. A payment link
/// is pushed over this, so none of these screens ever stands between a payer and a link.
struct SessionScreen: View {
    let session: SessionController
    let host: String
    let checker: ConnectionChecker
    let checkout: CheckoutController
    let wallet: WalletController
    @State private var confirmingSignOut = false
    @State private var signOutWarning = CheckoutCopy.signOutWarning

    var body: some View {
        Group {
            switch session.state {
            case .resolving:
                ResolvingView()
            case .signedOut(let reason):
                LoginView(session: session, reason: reason)
            case .signedIn(let user):
                // Keyed by the user, so a different person signing in never inherits this view's state.
                SignedInView(user: user, host: host, checker: checker, wallet: wallet, signOut: requestSignOut)
                    .id(user.id)
            case .offline(let message):
                OfflineView(message: message, retry: retry, signOut: requestSignOut)
            case .storageUnavailable:
                StorageUnavailableView(retry: retry)
            }
        }
        .task { await session.resolve() }
        .confirmationDialog("Sign out of Kobolink?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
            Button("Sign Out", role: .destructive, action: signOut)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(signOutWarning)
        }
        .alert(
            CheckoutCopy.signOutBlockedTitle,
            isPresented: Binding(get: { session.signOutBlocked }, set: { if !$0 { session.acknowledgeSignOutBlocked() } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(CheckoutCopy.signOutBlocked)
        }
    }

    /// Signing out forgets the payments this person started and has not finished, on this iPhone: a checkout, a
    /// wallet transfer, or both. Say so first, rather than discarding one without a word.
    private func requestSignOut() {
        let unfinished = SignOutGate.hasUnfinishedPayments(wallet: wallet, checkout: checkout)
        guard unfinished.checkout || unfinished.wallet else {
            signOut()
            return
        }
        signOutWarning = WalletCopy.signOutWarning(checkout: unfinished.checkout, wallet: unfinished.wallet)
        confirmingSignOut = true
    }

    private func retry() {
        Task { await session.retry() }
    }

    private func signOut() {
        Task { await session.signOut() }
    }
}

private struct ResolvingView: View {
    var body: some View {
        ProgressView("Checking your sign-in")
            .navigationTitle("Kobolink")
            .navigationBarTitleDisplayMode(.inline)
    }
}

/// Signed in: the wallet is the home. The account (who is signed in, the server, Sign Out) is a sheet from the
/// toolbar, the way an app's profile is: a focused sub-task with a clear Done. A payment link opened from outside
/// is pushed over this, so it never stands between a payer and a link.
struct SignedInView: View {
    let user: SignedInUser
    let host: String
    let checker: ConnectionChecker
    let wallet: WalletController
    let signOut: () -> Void
    @State private var showingAccount = false
    /// Sign Out was tapped in the sheet: it runs once the sheet is gone, so its confirmation is not shown from a
    /// view that is under a sheet.
    @State private var signOutAfterDismiss = false

    var body: some View {
        WalletHomeView(wallet: wallet, showAccount: { showingAccount = true })
            .sheet(isPresented: $showingAccount, onDismiss: signOutIfAsked) {
                NavigationStack {
                    HomeView(
                        user: user, host: host, checker: checker,
                        signOut: {
                            signOutAfterDismiss = true
                            showingAccount = false
                        }
                    )
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showingAccount = false }
                        }
                    }
                }
            }
    }

    private func signOutIfAsked() {
        guard signOutAfterDismiss else { return }
        signOutAfterDismiss = false
        signOut()
    }
}

/// The account: who is signed in, the server, and Sign Out. The merchant's links and payments join it later.
struct HomeView: View {
    let user: SignedInUser
    let host: String
    let checker: ConnectionChecker
    let signOut: () -> Void

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text(user.displayName)
                        .font(.headline)
                    Text(user.email)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(minHeight: 44, alignment: .leading)
                .accessibilityElement(children: .combine)
            } header: {
                Text("Signed in as")
            } footer: {
                Text("Your payment links and payments will appear here in a later update.")
            }

            ServerStatusSection(host: host, checker: checker)

            Section {
                Button("Sign Out", role: .destructive, action: signOut)
            }
        }
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// A token is saved, but the server could not confirm it. Nothing has been signed out.
private struct OfflineView: View {
    let message: String
    let retry: () -> Void
    let signOut: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Can't Confirm Your Sign-In", systemImage: "wifi.slash")
        } description: {
            Text(message)
        } actions: {
            Button("Try Again", action: retry)
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            Button("Sign Out", role: .destructive, action: signOut)
                .controlSize(.large)
        }
        .navigationTitle("Kobolink")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The Keychain could not be read. The saved sign-in has not been removed and is not assumed gone.
private struct StorageUnavailableView: View {
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Secure Storage Isn't Available", systemImage: "lock.slash")
        } description: {
            Text("Kobolink couldn't open your saved sign-in on this iPhone. Your sign-in hasn't been removed. Unlock your iPhone and try again.")
        } actions: {
            Button("Try Again", action: retry)
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
        }
        .navigationTitle("Kobolink")
        .navigationBarTitleDisplayMode(.inline)
    }
}

#Preview("Signed in") {
    NavigationStack {
        HomeView(
            user: SignedInUser(id: "u1", email: "merchant@example.test", displayName: "Adebayo Stores", role: .merchant),
            host: "pay.folusayo.com",
            checker: ConnectionChecker(api: PreviewHealthy()),
            signOut: {}
        )
    }
}

#Preview("Offline") {
    NavigationStack {
        OfflineView(
            message: "Kobolink can't reach its server, so it can't confirm you're still signed in. You haven't been signed out.",
            retry: {},
            signOut: {}
        )
    }
}

#Preview("Storage unavailable") {
    NavigationStack { StorageUnavailableView(retry: {}) }
}

private struct PreviewHealthy: HealthChecking {
    func health() async throws(APIError) {}
}
