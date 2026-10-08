import Foundation
import Observation

/// Why a read of the wallet failed, in words a person can act on. A failed read never blanks what is already on
/// screen: a balance from a minute ago, labelled with when it was true, is more use than an empty card.
public enum WalletReadProblem: Equatable, Sendable {
    case noConnection
    case rateLimited(retryAfterSeconds: Int?)
    case serverProblem
    case unreadable
    /// The session ended; the session layer is already taking the person to sign-in.
    case sessionEnded

    init(_ error: APIError) {
        switch error {
        case .unreachable, .cancelled: self = .noConnection
        case .undecodableResponse: self = .unreadable
        case .unexpectedResponse(let status):
            if status == 401 { self = .sessionEnded } else { self = status >= 500 ? .serverProblem : .unreadable }
        case .server(let server):
            if server.isUnauthenticated {
                self = .sessionEnded
            } else if server.code == .rate_limited {
                self = .rateLimited(retryAfterSeconds: server.retryAfterSeconds)
            } else {
                self = server.status >= 500 ? .serverProblem : .unreadable
            }
        }
    }
}

/// The wallet home: the balance the server derived and the activity list, with cursor paging.
///
/// What it guarantees:
/// - **The balance is the server's.** Nothing here computes one. It is shown with its `asOf`, and a read whose
///   `asOf` is older than the one held is dropped (a replayed transfer returns the ORIGINAL reply, with the balance
///   of the moment it first posted; an older answer is never presented as the current one).
/// - **Latest wins.** Every refresh starts a new generation; an older refresh, and any page of "load more" asked
///   for before it, is dropped instead of overwriting newer data or appending an old page to a new list.
/// - **A late reply cannot reach the next person.** `reset` (sign-out, a different user) bumps the epoch; anything
///   asked before it is dropped, so a previous user's balance is never written back.
@MainActor
@Observable
public final class WalletHomeController {
    public private(set) var balance: WalletBalance?
    public private(set) var balanceProblem: WalletReadProblem?
    public private(set) var items: [WalletActivity] = []
    public private(set) var nextCursor: String?
    public private(set) var activityProblem: WalletReadProblem?
    public private(set) var isRefreshing = false
    public private(set) var isLoadingMore = false
    /// False until the first refresh has answered, so the screen can tell "loading" from "nothing yet".
    public private(set) var hasLoaded = false

    @ObservationIgnored private let service: any WalletServing
    @ObservationIgnored private var epoch = 0
    @ObservationIgnored private var generation = 0
    /// A "load more" was asked for while a refresh was running; the refresh answers it when it finishes.
    @ObservationIgnored private var loadMoreWanted = false

    public init(service: any WalletServing) {
        self.service = service
    }

    // MARK: - Reading

    /// Read the balance and the first page together. Safe to call whenever: a newer refresh supersedes an older one.
    public func refresh() async {
        generation += 1
        let mine = generation
        let startedIn = epoch
        isRefreshing = true
        isLoadingMore = false
        let service = self.service

        // Unstructured: a pull-to-refresh being cancelled must not leave the screen half-updated.
        let (walletResult, pageResult) = await Task { () -> (Result<WalletBalance, APIError>, Result<ActivityPage, APIError>) in
            async let wallet = Self.result { () async throws(APIError) -> WalletBalance in try await service.wallet() }
            async let page = Self.result { () async throws(APIError) -> ActivityPage in try await service.activity(cursor: nil) }
            return await (wallet, page)
        }.value

        guard startedIn == epoch, mine == generation else { return }
        isRefreshing = false
        hasLoaded = true

        switch walletResult {
        case .success(let fresh):
            // Never go backwards: only a read as new as the one held replaces it.
            if let held = balance, fresh.asOf < held.asOf {
                break
            }
            balance = fresh
            balanceProblem = nil
        case .failure(let error):
            balanceProblem = WalletReadProblem(error)
        }

        switch pageResult {
        case .success(let page):
            items = page.items
            nextCursor = page.nextCursor
            activityProblem = nil
        case .failure(let error):
            activityProblem = WalletReadProblem(error)
        }

        // The "Loading more" row asks once, when it appears. If that happened while this refresh was running the ask
        // was refused, and the row would sit there for good: answer it now that a first page and a cursor are in place.
        if loadMoreWanted {
            loadMoreWanted = false
            loadMore()
        }
    }

    /// Fire-and-forget `refresh`, for events that are not a pull.
    public func refreshSoon() {
        Task { [weak self] in await self?.refresh() }
    }

    /// The next page of activity, if there is one and nothing else is being read.
    public func loadMore() {
        guard let cursor = nextCursor, !isLoadingMore else { return }
        guard !isRefreshing else {
            // Not now: a refresh is replacing the list and the cursor. Remember the ask; the refresh repeats it.
            loadMoreWanted = true
            return
        }
        isLoadingMore = true
        let startedIn = epoch
        let mine = generation
        let service = self.service
        Task { [weak self] in
            let result = await Self.result { () async throws(APIError) -> ActivityPage in try await service.activity(cursor: cursor) }
            self?.applyPage(result, epoch: startedIn, generation: mine)
        }
    }

    func applyPage(_ result: Result<ActivityPage, APIError>, epoch startedIn: Int, generation mine: Int) {
        // A refresh since this page was asked for replaced the list and the cursor: this page is stale, and
        // appending it would splice an old page onto a new list.
        guard startedIn == epoch, mine == generation else { return }
        isLoadingMore = false
        switch result {
        case .success(let page):
            let seen = Set(items.map(\.id))
            items += page.items.filter { !seen.contains($0.id) }
            nextCursor = page.nextCursor
            activityProblem = nil
        case .failure(let error):
            activityProblem = WalletReadProblem(error)
        }
    }

    // MARK: - After a transfer

    /// A transfer was posted. The reply carries the sender's wallet and the posted transaction, so both show at once.
    /// It also supersedes any read already in the air: that read may have been served before the transfer committed.
    /// The caller refreshes afterwards, because a REPLAY's reply is the original, however old.
    public func apply(_ receipt: TransferReceipt, replayed: Bool) {
        generation += 1
        isRefreshing = false
        isLoadingMore = false
        if let held = balance {
            if receipt.wallet.asOf >= held.asOf { balance = receipt.wallet }
        } else if !replayed {
            // A replay's balance can be hours old and there is nothing newer held to compare it with: a refresh
            // fetches the real one, and the old figure is not shown as if it were this moment's.
            balance = receipt.wallet
        }
        balanceProblem = nil
        items = [receipt.activity] + items.filter { $0.id != receipt.activity.id }
    }

    /// Sign-out or a different user: nothing of the previous one may remain in memory for the next.
    public func reset() {
        epoch += 1
        generation += 1
        loadMoreWanted = false
        balance = nil
        balanceProblem = nil
        items = []
        nextCursor = nil
        activityProblem = nil
        isRefreshing = false
        isLoadingMore = false
        hasLoaded = false
    }

    private nonisolated static func result<T: Sendable>(_ call: @Sendable () async throws(APIError) -> T) async -> Result<T, APIError> {
        do throws(APIError) {
            return .success(try await call())
        } catch {
            return .failure(error)
        }
    }
}
