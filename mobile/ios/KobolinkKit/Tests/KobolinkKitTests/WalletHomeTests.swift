import Foundation
import Testing

@testable import KobolinkKit

@MainActor
@Suite("Wallet home: the balance and the activity")
struct WalletHomeTests {
    private func page(_ ids: [String], next: String? = nil) -> ActivityPage {
        ActivityPage(items: ids.map { WK.activity($0) }, nextCursor: next)
    }

    private func make() -> (FakeWallet, WalletHomeController) {
        let service = FakeWallet()
        return (service, WalletHomeController(service: service))
    }

    @Test("a refresh shows the server's balance with its asOf, and the first page")
    func refresh() async {
        let (service, home) = make()
        service.queueWallet(.success(WK.balance(5_000_000)))
        service.queueActivity(.success(page(["a", "b"], next: "c1")))
        await home.refresh()
        #expect(home.balance == WK.balance(5_000_000))
        #expect(home.items.map(\.id) == ["a", "b"])
        #expect(home.nextCursor == "c1")
        #expect(home.hasLoaded && !home.isRefreshing)
        #expect(home.balanceProblem == nil && home.activityProblem == nil)
    }

    @Test("a failed refresh keeps what was held and says what failed")
    func failedRefreshKeeps() async {
        let (service, home) = make()
        service.queueWallet(.success(WK.balance(5_000_000)))
        service.queueActivity(.success(page(["a"])))
        await home.refresh()
        service.queueWallet(.failure(.unreachable(.notConnectedToInternet)))
        service.queueActivity(.failure(.unexpectedResponse(status: 503)))
        await home.refresh()
        #expect(home.balance?.balanceKobo == 5_000_000)
        #expect(home.items.map(\.id) == ["a"])
        #expect(home.balanceProblem == .noConnection)
        #expect(home.activityProblem == .serverProblem)
    }

    @Test("every read problem has words")
    func problemWords() {
        for problem in [WalletReadProblem.noConnection, .rateLimited(retryAfterSeconds: 30), .serverProblem, .unreadable, .sessionEnded] {
            #expect(WalletCopy.readProblem(problem, what: "your balance").hasPrefix("Couldn't update your balance"))
        }
    }

    // MARK: asOf

    @Test("a read older than the balance held does not replace it: an older answer is never presented as the current one")
    func olderReadDropped() async {
        let (service, home) = make()
        service.queueWallet(.success(WK.balance(3_000_000, asOf: WK.at.addingTimeInterval(60))))
        service.queueActivity(.success(page([])))
        await home.refresh()
        service.queueWallet(.success(WK.balance(9_000_000, asOf: WK.at)))
        service.queueActivity(.success(page([])))
        await home.refresh()
        #expect(home.balance?.balanceKobo == 3_000_000)
        #expect(home.balance?.asOf == WK.at.addingTimeInterval(60))
    }

    @Test("a read with the same asOf or newer does replace it")
    func newerReadWins() async {
        let (service, home) = make()
        service.queueWallet(.success(WK.balance(3_000_000, asOf: WK.at)))
        service.queueActivity(.success(page([])))
        await home.refresh()
        service.queueWallet(.success(WK.balance(2_000_000, asOf: WK.at)))
        service.queueActivity(.success(page([])))
        await home.refresh()
        #expect(home.balance?.balanceKobo == 2_000_000)
    }

    @Test("a REPLAYED transfer's reply has the original, old balance: it does not go backwards past one held")
    func replayDoesNotGoBackwards() async {
        let (service, home) = make()
        service.queueWallet(.success(WK.balance(1_000_000, asOf: WK.at.addingTimeInterval(3_600))))
        service.queueActivity(.success(page([])))
        await home.refresh()
        let original = WK.receipt(balanceKobo: 4_850_000, asOf: WK.at)
        home.apply(original, replayed: true)
        #expect(home.balance?.balanceKobo == 1_000_000)
        #expect(home.items.first?.id == original.activity.id, "the posting itself is still listed")
    }

    @Test("with no balance held, a replay's old figure is not adopted as the balance")
    func replayWithNothingHeld() {
        let (_, home) = make()
        home.apply(WK.receipt(balanceKobo: 4_850_000), replayed: true)
        #expect(home.balance == nil)
        home.apply(WK.receipt(balanceKobo: 4_850_000, id: "pst_2"), replayed: false)
        #expect(home.balance?.balanceKobo == 4_850_000)
    }

    @Test("a first-send reply newer than the held balance replaces it, and is listed once however often it is applied")
    func firstSendApplies() async {
        let (service, home) = make()
        service.queueWallet(.success(WK.balance(5_000_000, asOf: WK.at)))
        service.queueActivity(.success(page(["x"])))
        await home.refresh()
        let receipt = WK.receipt(balanceKobo: 4_850_000, asOf: WK.at.addingTimeInterval(10))
        home.apply(receipt, replayed: false)
        home.apply(receipt, replayed: false)
        #expect(home.balance?.balanceKobo == 4_850_000)
        #expect(home.items.map(\.id) == ["pst_1", "x"])
    }

    @Test("a read that was already in the air when a transfer landed is dropped: it may predate the posting")
    func readBeforeTransferDropped() async {
        let (service, home) = make()
        let gate = Gate()
        service.queueWallet(.success(WK.balance(5_000_000, asOf: WK.at)), gate: gate)
        service.queueActivity(.success(page(["old"])), gate: gate)
        home.refreshSoon()
        #expect(await waitUntil { home.isRefreshing })
        home.apply(WK.receipt(balanceKobo: 4_850_000, asOf: WK.at.addingTimeInterval(10)), replayed: false)
        gate.open()
        await Task.yield()
        try? await Task.sleep(for: .milliseconds(30))
        #expect(home.balance?.balanceKobo == 4_850_000)
        #expect(home.items.map(\.id) == ["pst_1"])
    }

    // MARK: Paging

    @Test("load more appends the next page once, without duplicates")
    func loadMore() async {
        let (service, home) = make()
        service.queueWallet(.success(WK.balance()))
        service.queueActivity(.success(page(["a", "b"], next: "c1")))
        await home.refresh()
        service.queueActivity(.success(page(["b", "c"], next: nil)))
        home.loadMore()
        home.loadMore()
        #expect(await waitUntil { home.nextCursor == nil && !home.isLoadingMore })
        #expect(home.items.map(\.id) == ["a", "b", "c"])
        #expect(service.cursors == [nil, "c1"], "the second tap found a load already running")
        home.loadMore()
        #expect(service.cursors.count == 2, "no cursor, no request")
    }

    @Test("a load-more asked for while a refresh runs is not lost: it runs when the refresh is done, so the spinner cannot stick")
    func loadMoreDuringRefresh() async {
        let (service, home) = make()
        service.queueWallet(.success(WK.balance()))
        service.queueActivity(.success(page(["a", "b"], next: "c1")))
        await home.refresh()

        let gate = Gate()
        service.queueWallet(.success(WK.balance()), gate: gate)
        service.queueActivity(.success(page(["n1", "n2"], next: "d1")), gate: gate)
        home.refreshSoon()
        #expect(await waitUntil { service.cursors.count == 2 && home.isRefreshing })

        // The spinner row appeared while the refresh was running: its one onAppear is refused...
        home.loadMore()
        #expect(service.cursors.count == 2, "refused while the refresh runs")

        // ...and must still be answered once the refresh has put a first page and a cursor in place.
        service.queueActivity(.success(page(["n3"], next: nil)))
        gate.open()
        #expect(await waitUntil { home.items.map(\.id) == ["n1", "n2", "n3"] })
        #expect(service.cursors == [nil, nil, "d1"])
        #expect(home.nextCursor == nil && !home.isLoadingMore)
    }

    @Test("a load-more that was never asked for is not invented by a refresh")
    func refreshDoesNotLoadMoreByItself() async {
        let (service, home) = make()
        service.queueWallet(.success(WK.balance()))
        service.queueActivity(.success(page(["a"], next: "c1")))
        await home.refresh()
        service.queueWallet(.success(WK.balance()))
        service.queueActivity(.success(page(["a"], next: "c1")))
        await home.refresh()
        try? await Task.sleep(for: .milliseconds(30))
        #expect(service.cursors == [nil, nil])
    }

    @Test("a page asked for before a refresh is dropped: it is not spliced onto the new list")
    func stalePageAfterRefresh() async {
        let (service, home) = make()
        service.queueWallet(.success(WK.balance()))
        service.queueActivity(.success(page(["a", "b"], next: "c1")))
        await home.refresh()

        let gate = Gate()
        service.queueActivity(.success(page(["old1", "old2"], next: "c2")), gate: gate)
        home.loadMore()
        #expect(await waitUntil { service.cursors.count == 2 })
        #expect(home.isLoadingMore)

        service.queueWallet(.success(WK.balance()))
        service.queueActivity(.success(page(["n1", "n2"], next: "d1")))
        await home.refresh()
        #expect(home.items.map(\.id) == ["n1", "n2"])
        #expect(!home.isLoadingMore)

        gate.open()
        try? await Task.sleep(for: .milliseconds(40))
        #expect(home.items.map(\.id) == ["n1", "n2"], "the old page did not land")
        #expect(home.nextCursor == "d1", "and did not move the cursor")
    }

    @Test("a page that fails keeps the list and shows the problem; the cursor stays so it can be asked again")
    func pageFails() async {
        let (service, home) = make()
        service.queueWallet(.success(WK.balance()))
        service.queueActivity(.success(page(["a"], next: "c1")))
        await home.refresh()
        service.queueActivity(.failure(.unreachable(.timedOut)))
        home.loadMore()
        #expect(await waitUntil { home.activityProblem != nil })
        #expect(home.items.map(\.id) == ["a"])
        #expect(home.nextCursor == "c1")
        #expect(!home.isLoadingMore)
    }

    // MARK: Latest wins, and not the next person's

    @Test("the older of two refreshes is dropped when it finishes last")
    func olderRefreshLosing() async {
        let (service, home) = make()
        let slow = Gate()
        service.queueWallet(.success(WK.balance(1_000, asOf: WK.at)), gate: slow)
        service.queueActivity(.success(page(["slow"])), gate: slow)
        home.refreshSoon()
        #expect(await waitUntil { service.walletReads == 1 })
        service.queueWallet(.success(WK.balance(2_000, asOf: WK.at.addingTimeInterval(5))))
        service.queueActivity(.success(page(["fast"])))
        await home.refresh()
        #expect(home.items.map(\.id) == ["fast"])
        slow.open()
        try? await Task.sleep(for: .milliseconds(40))
        #expect(home.items.map(\.id) == ["fast"])
        #expect(home.balance?.balanceKobo == 2_000)
    }

    @Test("a reply that arrives after a reset is dropped: the previous user's balance is not written back")
    func lateReadAfterReset() async {
        let (service, home) = make()
        let gate = Gate()
        service.queueWallet(.success(WK.balance(7_000_000)), gate: gate)
        service.queueActivity(.success(page(["private"])), gate: gate)
        home.refreshSoon()
        #expect(await waitUntil { home.isRefreshing })
        home.reset()
        gate.open()
        try? await Task.sleep(for: .milliseconds(40))
        #expect(home.balance == nil)
        #expect(home.items.isEmpty)
        #expect(!home.hasLoaded)
        #expect(!home.isRefreshing)
    }

    @Test("a page that arrives after a reset is dropped too")
    func latePageAfterReset() async {
        let (service, home) = make()
        service.queueWallet(.success(WK.balance()))
        service.queueActivity(.success(page(["a"], next: "c1")))
        await home.refresh()
        let gate = Gate()
        service.queueActivity(.success(page(["private"], next: nil)), gate: gate)
        home.loadMore()
        #expect(await waitUntil { service.cursors.count == 2 })
        home.reset()
        gate.open()
        try? await Task.sleep(for: .milliseconds(40))
        #expect(home.items.isEmpty)
    }
}
