import KobolinkKit
import SwiftUI

/// The wallet tab: the balance the server derived, the two ways to pay, and recent activity. It renders
/// `WalletController` and forwards taps; every decision is in the package.
struct WalletHomeView: View {
    @Bindable var wallet: WalletController
    let showAccount: () -> Void

    var body: some View {
        let home = wallet.home
        List {
            if let attempt = wallet.send.unresolved {
                Section {
                    UnfinishedPayment(attempt: attempt, review: wallet.openSend)
                }
            }

            Section {
                BalanceRow(home: home)
            }

            Section {
                Button(action: wallet.openSend) {
                    Label("Send Money", systemImage: "paperplane.fill")
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                Button(action: wallet.openScan) {
                    Label("Scan to Pay", systemImage: "qrcode.viewfinder")
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
            }

            ActivitySection(home: home)
        }
        .navigationTitle("Wallet")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: showAccount) {
                    Image(systemName: "person.crop.circle")
                }
                .accessibilityLabel("Account")
            }
        }
        .refreshable { await home.refresh() }
        .task { await home.refresh() }
        .sheet(isPresented: $wallet.isSendPresented, onDismiss: wallet.sheetDidDismiss) {
            SendSheet(wallet: wallet)
        }
    }
}

// MARK: - Balance

/// The balance, with the time it was true. A figure the server gave a while ago is labelled with when, never
/// presented as the balance right now.
private struct BalanceRow: View {
    let home: WalletHomeController

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Wallet balance")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if let balance = home.balance {
                Text(Kobo.formatNaira(balance.balanceKobo, alwaysShowKobo: true))
                    .font(.largeTitle.bold())
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.4)
                Text(home.isRefreshing ? "Updating" : "As of \(CheckoutCopy.formatDate(balance.asOf))")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else if home.hasLoaded {
                Text("Not available")
                    .font(.title2.bold())
                    .foregroundStyle(.secondary)
            } else {
                Text("₦00,000.00")
                    .font(.largeTitle.bold())
                    .monospacedDigit()
                    .redacted(reason: .placeholder)
            }
            if let problem = home.balanceProblem {
                Label(WalletCopy.readProblem(problem, what: "your balance"), systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(Color.warningText)
            }
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(spoken)
    }

    private var spoken: String {
        guard let balance = home.balance else { return home.hasLoaded ? "Wallet balance not available" : "Loading wallet balance" }
        return "Wallet balance, \(Kobo.spokenNaira(balance.balanceKobo)), as of \(CheckoutCopy.formatDate(balance.asOf))"
    }
}

// MARK: - An unfinished payment

private struct UnfinishedPayment: View {
    let attempt: TransferAttempt
    let review: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(WalletCopy.unfinishedHeading(), systemImage: "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(Color.warningText)
            Text(WalletCopy.unfinishedBody(attempt))
                .font(.subheadline)
            Button("Review Payment", action: review)
                .buttonStyle(.bordered)
                .controlSize(.large)
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Activity

private struct ActivitySection: View {
    let home: WalletHomeController

    var body: some View {
        Section {
            if home.items.isEmpty {
                empty
            }
            ForEach(home.items) { item in
                ActivityRow(item: item)
            }
            if home.nextCursor != nil {
                more
            }
        } header: {
            Text("Recent activity")
        }
    }

    @ViewBuilder private var empty: some View {
        if let problem = home.activityProblem {
            VStack(alignment: .leading, spacing: 8) {
                Label(WalletCopy.readProblem(problem, what: "recent activity"), systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline)
                    .foregroundStyle(Color.warningText)
                Button("Try Again") { home.refreshSoon() }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
            }
            .padding(.vertical, 4)
        } else if home.hasLoaded {
            Text("No activity yet. Money you send or receive shows up here.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(minHeight: 44, alignment: .leading)
        } else {
            ProgressView("Loading activity")
                .frame(maxWidth: .infinity, minHeight: 44)
        }
    }

    @ViewBuilder private var more: some View {
        if let problem = home.activityProblem, !home.items.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Label(WalletCopy.readProblem(problem, what: "more activity"), systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(Color.warningText)
                Button("Load More") { home.loadMore() }
                    .buttonStyle(.bordered)
            }
            .padding(.vertical, 4)
        } else if !home.items.isEmpty {
            ProgressView("Loading more")
                .frame(maxWidth: .infinity, minHeight: 44)
                .onAppear { home.loadMore() }
        }
    }
}

private struct ActivityRow: View {
    let item: WalletActivity

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(WalletCopy.activityTitle(item))
                    .font(.body)
                if let note = item.note, !note.isEmpty {
                    Text(note)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Text(CheckoutCopy.formatDate(item.createdAt))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Text(WalletCopy.activityAmount(item))
                .font(.body.weight(.semibold))
                .monospacedDigit()
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(WalletCopy.activitySpoken(item))
    }
}
