import Foundation
import Testing

@testable import KobolinkKit

/// Bodies the REAL apps/api sent (feature X2: the app was driven against a real server and a real
/// Postgres, and every request/response pair was captured). Names, emails, ids and codes are invented
/// test data from that run. They are fixtures, not a spec: `GeneratedModelDecodeTests` and the stubs in
/// the checkout and wallet suites were written from `packages/contracts`, and these pin that the
/// server's actual bytes (key order, `.000Z` dates, `null` where a key is optional, the statuses and
/// codes of each refusal) still decode through the app's own client and land on the app's own verdicts.
///
/// `ios-real-api-smoke.sh` and `RealAPIIntegrationTests` are the live twins of these.
@Suite("Payloads captured from the real API")
struct RealServerPayloadTests {

    // MARK: Fixtures

    private enum Real {
        static let loginOK = """
            {"user":{"id":"Pq5-H82zqOd6rNp7w8wbW","role":"customer","email":"ada@x2.example.test","phone":"+2348031110002",\
            "displayName":"Ada Okafor","createdAt":"2026-10-08T04:59:13.535Z"},\
            "session":{"id":"sess_2kQ8wLm4NpZ7vXcR1tYbA","expiresAt":"2026-11-07T05:01:21.202Z"},\
            "token":"x2TestTokenNotARealOne-0123456789abcdefghij"}
            """
        static let unauthenticated = #"{"code":"unauthenticated","message":"Incorrect email or password."}"#
        /// `GET /api/links/{code}/public`: no `moneyMoved`, it is a read.
        static let notFound = #"{"code":"not_found","message":"Link not found."}"#
        /// `POST /api/checkout/initialize` and `POST /api/wallet/transfer` say `moneyMoved: false`.
        static let initializeNotFound = #"{"code":"not_found","message":"No link with that code.","moneyMoved":false}"#
        static let recipientNotFound =
            #"{"code":"not_found","message":"No wallet is registered to that phone number.","moneyMoved":false}"#
        static let insufficient = #"{"code":"insufficient_funds","message":"Insufficient wallet balance.","moneyMoved":false}"#
        static let idempotencyMismatch =
            #"{"code":"idempotency_mismatch","message":"This Idempotency-Key was already used with a different request.","moneyMoved":false}"#
        static let amountMismatch = #"{"code":"amount_mismatch","message":"That amount does not match this link.","moneyMoved":false}"#
        static let notPayableDisabled =
            #"{"code":"link_not_payable","message":"This link cannot be paid right now.","moneyMoved":false,"state":"disabled"}"#
        static let notPayableAlreadyPaid =
            #"{"code":"link_not_payable","message":"This link cannot be paid right now.","moneyMoved":false,"state":"already-paid"}"#
        static let ownNumber =
            #"{"code":"validation_failed","message":"You cannot transfer money to yourself.","fields":{"toPhone":["cannot transfer to yourself"]},"moneyMoved":false}"#
        static let rateLimited = #"{"code":"rate_limited","message":"Too many login attempts. Try again later."}"#

        static let fixedLink = """
            {"state":"payable","link":{"code":"mrdqHeK3","merchantName":"Kemi Stores","title":"Ankara fabric, 2 yards",\
            "description":"Delivery in Lagos within 3 days.","amountKobo":250000,"currency":"NGN","isReusable":true,"expiresAt":null}}
            """
        static let openLink = """
            {"state":"payable","link":{"code":"jGBQQAS3","merchantName":"Kemi Stores","title":"Pay Kemi Stores",\
            "description":null,"amountKobo":null,"currency":"NGN","isReusable":true,"expiresAt":null}}
            """
        static let expiredLink = """
            {"state":"expired","link":{"code":"nRbXqCX8","merchantName":"Kemi Stores","title":"Expiring link",\
            "description":null,"amountKobo":100000,"currency":"NGN","isReusable":true,"expiresAt":"2026-10-08T04:59:38.000Z"}}
            """
        static let alreadyPaidLink = """
            {"state":"already-paid","link":{"code":"Xt4ZYHSw","merchantName":"Kemi Stores","title":"Single use",\
            "description":null,"amountKobo":100000,"currency":"NGN","isReusable":false,"expiresAt":null}}
            """

        static let started = """
            {"reference":"kbl_FQNbvV8uPP","code":"mrdqHeK3","amountKobo":250000,"currency":"NGN","status":"pending",\
            "createdAt":"2026-10-08T05:04:12.865Z"}
            """
        static let paid = """
            {"payment":{"reference":"kbl_FQNbvV8uPP","code":"mrdqHeK3","amountKobo":250000,"currency":"NGN","status":"success",\
            "payerName":"Chidi Payer","payerEmail":"c***@example.test","createdAt":"2026-10-08T05:04:12.979Z",\
            "completedAt":"2026-10-08T05:04:12.979Z","failureReason":null,"moneyMoved":true}}
            """
        static let declined = """
            {"payment":{"reference":"kbl_J25krTwXRs","code":"edie3kYG","amountKobo":120000,"currency":"NGN","status":"failed",\
            "payerName":"Fay Ledger","payerEmail":"f***@example.test","createdAt":"2026-10-08T05:04:34.710Z",\
            "completedAt":"2026-10-08T05:04:34.710Z","failureReason":"Card declined by the simulated gateway.","moneyMoved":false}}
            """
        static let expiredAtVerify = """
            {"payment":{"reference":"kbl_5C7rPgbWuB","code":"ZoomZPxN","amountKobo":100000,"currency":"NGN","status":"failed",\
            "payerName":"Late Payer","payerEmail":"l***@example.test","createdAt":"2026-10-08T05:07:42.505Z",\
            "completedAt":"2026-10-08T05:07:42.505Z","failureReason":"Link has expired","moneyMoved":false}}
            """

        static let wallet = #"{"accountId":"wkcZ4eKaN-013ORZ06chq","currency":"NGN","balanceKobo":1000000,"asOf":"2026-10-08T05:01:42.074Z"}"#
        static let transferNoNote = """
            {"transaction":{"postingId":"2PRV5TUhiGEduzQXdEPmX","kind":"transfer","amountKobo":-15000,"counterparty":"Bola Adeyemi",\
            "note":null,"createdAt":"2026-10-08T05:02:22.817Z"},\
            "wallet":{"accountId":"wkcZ4eKaN-013ORZ06chq","currency":"NGN","balanceKobo":985000,"asOf":"2026-10-08T05:02:22.817Z"}}
            """
        /// A replay is served from `jsonb`, so its keys come back in a different order.
        static let transferNoNoteReplay = """
            {"wallet":{"asOf":"2026-10-08T05:02:22.817Z","currency":"NGN","accountId":"wkcZ4eKaN-013ORZ06chq","balanceKobo":985000},\
            "transaction":{"kind":"transfer","note":null,"createdAt":"2026-10-08T05:02:22.817Z","postingId":"2PRV5TUhiGEduzQXdEPmX",\
            "amountKobo":-15000,"counterparty":"Bola Adeyemi"}}
            """
        static let activity = """
            {"items":[\
            {"postingId":"gwGTG7nwNSTzY1Re5P-rR","kind":"transfer","amountKobo":-12050,"counterparty":"Bola Adeyemi","note":"Lunch money","createdAt":"2026-10-08T05:03:21.041Z"},\
            {"postingId":"bRBaA8-Bl0TtX4ymysUVT","kind":"topup","amountKobo":1000000,"counterparty":null,"note":null,"createdAt":"2026-10-08T04:59:14.100Z"}],\
            "nextCursor":null}
            """
        /// A whitespace-only note (the web client, or any client that does not drop it) is trimmed by the server's
        /// schema to "" and STORED as "", and the activity read returns `"note":""`, not `null`.
        static let activityBlankNote = """
            {"items":[\
            {"postingId":"899bB099cjcgp8sG-ntyC","kind":"transfer","amountKobo":-10000,"counterparty":"Bola Adeyemi","note":"","createdAt":"2026-10-08T05:11:51.790Z"}],\
            "nextCursor":null}
            """
    }

    private let key = "11111111-1111-4111-8111-000000000001"

    private func server(_ call: () async throws(APIError) -> some Sendable) async -> ServerError? {
        do throws(APIError) {
            _ = try await call()
            return nil
        } catch {
            if case .server(let refusal) = error { return refusal }
            return nil
        }
    }

    // MARK: Auth

    @Test("a mobile login body decodes: user, role, token")
    func login() async throws {
        let session = try await makeClient(.json(Real.loginOK)).login(email: "ada@x2.example.test", password: "irrelevant")
        #expect(session.user.role == .customer)
        #expect(session.user.displayName == "Ada Okafor")
        #expect(session.token != nil)
    }

    @Test("a wrong password is 401 unauthenticated, and the login screen's own mapping calls it invalid credentials")
    func wrongPassword() async throws {
        let refusal = await server { () async throws(APIError) in
            try await makeClient(.json(Real.unauthenticated, status: 401)).login(email: "a@b.test", password: "x")
        }
        #expect(refusal?.status == 401)
        #expect(refusal?.code == .unauthenticated)
        #expect(refusal?.isUnauthenticated == true)
    }

    @Test("the 429 carries Retry-After as whole seconds, which the generated model does not declare")
    func rateLimited() async throws {
        var transport = StubTransport.json(Real.rateLimited, status: 429)
        transport.responseHeaders[.retryAfter] = "900"
        let refusal = await server { () async throws(APIError) in
            try await makeClient(transport).login(email: "a@b.test", password: "x")
        }
        #expect(refusal?.code == .rate_limited)
        #expect(refusal?.retryAfterSeconds == 900)
    }

    // MARK: Public links

    @Test("every public link state the server writes decodes to the matching availability")
    func publicLinkStates() async throws {
        let code = try #require(LinkCode("mrdqHeK3"))
        let fixed = try await makeClient(.json(Real.fixedLink)).lookupLink(code: code)
        #expect(fixed.availability == .payable)
        #expect(fixed.link.amountKobo == 250_000)
        #expect(fixed.link.description == "Delivery in Lagos within 3 days.")

        let open = try await makeClient(.json(Real.openLink)).lookupLink(code: code)
        #expect(open.link.amountKobo == nil)
        #expect(open.link.description == nil)

        let expired = try await makeClient(.json(Real.expiredLink)).lookupLink(code: code)
        #expect(expired.availability == .expired)
        #expect(expired.link.expiresAt == Date(timeIntervalSince1970: 1_791_435_578))

        let paid = try await makeClient(.json(Real.alreadyPaidLink)).lookupLink(code: code)
        #expect(paid.availability == .alreadyPaid)
        #expect(!paid.link.isReusable)
    }

    @Test("an unknown code is 404 not_found")
    func unknownLink() async throws {
        let refusal = await server { () async throws(APIError) in
            try await makeClient(.json(Real.notFound, status: 404)).lookupLink(code: LinkCode("ZZZZZZZ2")!)
        }
        #expect(refusal?.status == 404)
        #expect(refusal?.code == .not_found)
    }

    // MARK: Checkout

    @Test("initialize and verify decode; a decline is failed with moneyMoved false and the server's reason")
    func checkout() async throws {
        let started = try await makeClient(.json(Real.started, status: 201)).initializeCheckout(
            InitializeRequest(code: LinkCode("mrdqHeK3")!, amountKobo: 250_000, payerName: "Chidi Payer", payerEmail: "chidi@example.test"),
            idempotencyKey: key)
        #expect(started.reference == "kbl_FQNbvV8uPP")
        #expect(started.amountKobo == 250_000)

        let paid = try await makeClient(.json(Real.paid)).verifyCheckout(reference: "kbl_FQNbvV8uPP", idempotencyKey: key)
        #expect(paid.status == .success)
        #expect(paid.moneyMoved)

        let declined = try await makeClient(.json(Real.declined)).verifyCheckout(reference: "kbl_J25krTwXRs", idempotencyKey: key)
        #expect(declined.status == .failed)
        #expect(!declined.moneyMoved)
        #expect(declined.failureReason == "Card declined by the simulated gateway.")
    }

    @Test("a link that expired between initialize and verify is a failed payment the app words as a link problem")
    func expiredBetweenInitializeAndVerify() async throws {
        let payment = try await makeClient(.json(Real.expiredAtVerify)).verifyCheckout(reference: "kbl_5C7rPgbWuB", idempotencyKey: key)
        #expect(payment.status == .failed)
        #expect(VerifyVerdict.linkProblem(forReason: payment.failureReason) == .linkExpired)
    }

    @Test("the refusals the idempotency layer stores keep the statuses the app's verdict tables are written against")
    func refusalStatuses() async throws {
        let request = InitializeRequest(code: LinkCode("mrdqHeK3")!, amountKobo: 250_000, payerName: "Chidi Payer", payerEmail: "chidi@example.test")
        for (status, body, code) in [
            (422, Real.amountMismatch, ApiErrorCode.amount_mismatch),
            (409, Real.notPayableDisabled, .link_not_payable),
            (409, Real.notPayableAlreadyPaid, .link_not_payable),
            (404, Real.initializeNotFound, .not_found),
        ] {
            let refusal = await server { () async throws(APIError) in
                try await makeClient(.json(body, status: status)).initializeCheckout(request, idempotencyKey: key)
            }
            #expect(refusal?.code == code)
            #expect(refusal?.moneyMoved == false)
            let verdict = SendVerdict.of(.failure(.server(try #require(refusal))), request: request, firstEverSend: true)
            guard case .settled = verdict else {
                Issue.record("\(code) at \(status) should settle the attempt, got \(verdict)")
                continue
            }
        }
        let paid = await server { () async throws(APIError) in
            try await makeClient(.json(Real.notPayableAlreadyPaid, status: 409)).initializeCheckout(request, idempotencyKey: key)
        }
        #expect(paid?.linkState == .already_hyphen_paid)
    }

    // MARK: Wallet

    @Test("a wallet, a note-less transfer, its replay (keys in another order), and an activity page decode")
    func wallet() async throws {
        let balance = try await makeClient(.json(Real.wallet)).wallet()
        #expect(balance.balanceKobo == 1_000_000)

        let instruction = TransferInstruction(toPhone: "+2348031110003", amountKobo: 15_000, note: nil)
        let receipt = try await makeClient(.json(Real.transferNoNote, status: 201)).transfer(instruction, idempotencyKey: key)
        let replay = try await makeClient(.json(Real.transferNoNoteReplay, status: 201)).transfer(instruction, idempotencyKey: key)
        #expect(receipt == replay)
        #expect(receipt.activity.note == nil)
        #expect(receipt.activity.counterparty == "Bola Adeyemi")
        #expect(receipt.wallet.balanceKobo == 985_000)
        let verdict = TransferVerdict.of(.success(receipt), instruction: instruction, firstEverSend: true)
        #expect(verdict == .sent(receipt))

        let page = try await makeClient(.json(Real.activity)).activity(cursor: nil)
        #expect(page.items.count == 2)
        #expect(page.items[0].note == "Lunch money")
        #expect(page.items[0].amountKobo == -12_050)
        #expect(page.items[1].kind == .topUp)
        #expect(page.items[1].counterparty == nil)
        #expect(page.nextCursor == nil)
    }

    @Test("the transfer refusals the server stores settle the attempt; a mismatch of keys does not")
    func transferRefusals() async throws {
        let instruction = TransferInstruction(toPhone: "+2348031110003", amountKobo: 5_000_000, note: nil)
        func verdict(_ body: String, status: Int) async throws -> TransferVerdict {
            let refusal = await server { () async throws(APIError) in
                try await makeClient(.json(body, status: status)).transfer(instruction, idempotencyKey: key)
            }
            return TransferVerdict.of(.failure(.server(try #require(refusal))), instruction: instruction, firstEverSend: false)
        }
        #expect(try await verdict(Real.insufficient, status: 422) == .settled(.insufficientFunds))
        #expect(try await verdict(Real.ownNumber, status: 400) == .settled(.ownNumber))
        #expect(try await verdict(Real.recipientNotFound, status: 404) == .settled(.recipientNotFound))
        #expect(try await verdict(Real.idempotencyMismatch, status: 422) == .unsettled(.keyConflict))
    }

    @Test("a blank note the server stored is no note: nothing is shown and VoiceOver does not read an empty one")
    func blankNote() async throws {
        let page = try await makeClient(.json(Real.activityBlankNote)).activity(cursor: nil)
        let item = try #require(page.items.first)
        #expect(item.note == nil)
        #expect(!WalletCopy.activitySpoken(item).contains("note"))
    }
}
