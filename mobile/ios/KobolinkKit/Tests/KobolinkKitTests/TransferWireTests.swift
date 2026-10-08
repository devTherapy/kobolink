import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import KobolinkKit

private let key = "11111111-1111-4111-8111-000000000001"

private enum Wire {
    static func transaction(
        id: String = "pst_1", kind: String = "transfer", amount: String = "-150000", counterparty: String = "\"Ada Obi\"",
        note: String = "null", createdAt: String = "2026-10-08T10:15:30.000Z"
    ) -> String {
        """
        {"postingId":"\(id)","kind":"\(kind)","amountKobo":\(amount),"counterparty":\(counterparty),\
        "note":\(note),"createdAt":"\(createdAt)"}
        """
    }

    static func wallet(balance: String = "4850000", currency: String = "NGN", asOf: String = "2026-10-08T10:15:30.000Z") -> String {
        """
        {"accountId":"acc_one","currency":"\(currency)","balanceKobo":\(balance),"asOf":"\(asOf)"}
        """
    }

    static var transferred: String { "{\"transaction\":\(transaction()),\"wallet\":\(wallet())}" }

    static func page(items: [String], next: String = "null") -> String {
        "{\"items\":[\(items.joined(separator: ","))],\"nextCursor\":\(next)}"
    }
}

/// A client with the real middleware and a user's token in the store, built over a transport that answers from memory
/// so the REAL generated request building and decoding run.
private struct Rig {
    let transport: StubTransport
    let client: KobolinkAPIClient

    /// `tokenOrigin` is the origin the middleware is configured for; the client's own is `pay.example.test`.
    init(_ transport: StubTransport, token: SessionToken? = Fixture.tokenA, tokenOrigin: String = "https://pay.example.test") {
        self.transport = transport
        client = KobolinkAPIClient(
            configuration: APIConfiguration(baseURL: URL(string: "https://pay.example.test")!),
            transport: transport,
            middlewares: [
                AuthMiddleware(
                    baseURL: URL(string: tokenOrigin)!, tokenStore: InMemoryTokenStore(token: token), relay: SessionRejectionRelay())
            ]
        )
    }

    var sent: [RequestRecorder.Entry] { transport.recorder.all }

    func transfer(_ instruction: TransferInstruction = WK.instruction()) async -> Result<TransferReceipt, APIError> {
        do throws(APIError) {
            return .success(try await client.transfer(instruction, idempotencyKey: key))
        } catch {
            return .failure(error)
        }
    }

    func wallet() async -> Result<WalletBalance, APIError> {
        do throws(APIError) {
            return .success(try await client.wallet())
        } catch {
            return .failure(error)
        }
    }

    func activity(cursor: String? = nil) async -> Result<ActivityPage, APIError> {
        do throws(APIError) {
            return .success(try await client.activity(cursor: cursor))
        } catch {
            return .failure(error)
        }
    }
}

@Suite("Transfer on the wire: the request through the REAL generated client")
struct TransferWireTests {
    private func body(_ rig: Rig) throws -> (text: String, json: [String: Any]) {
        let sent = try #require(rig.sent.first)
        let json = try #require(JSONSerialization.jsonObject(with: Data(sent.bodyText.utf8)) as? [String: Any])
        return (sent.bodyText, json)
    }

    // Lesson 1. Android sent `"note": null`; contracts say `note` is optional, NOT nullable, so every note-less send
    // (and every scan-to-pay, which has no note) would have been refused with a 400.
    @Test("a payment with NO note omits the key: the body is exactly toPhone and amountKobo, never \"note\":null")
    func noteOmitted() async throws {
        let rig = Rig(.json(Wire.transferred, status: 201))
        _ = await rig.transfer(WK.instruction(note: nil))
        let (text, json) = try body(rig)
        #expect(Set(json.keys) == ["toPhone", "amountKobo"])
        #expect(!text.contains("note"), "\(text)")
        #expect(!text.contains("null"), "\(text)")
        #expect(json["toPhone"] as? String == "+2348031234567")
        #expect(json["amountKobo"] as? Int == 150_000)
    }

    @Test("a payment with a note sends it as a string")
    func notePresent() async throws {
        let rig = Rig(.json(Wire.transferred, status: 201))
        _ = await rig.transfer(WK.instruction(note: "Rent for October"))
        let (_, json) = try body(rig)
        #expect(Set(json.keys) == ["toPhone", "amountKobo", "note"])
        #expect(json["note"] as? String == "Rent for October")
    }

    @Test("the form's path to the wire never produces a null note, whatever was typed", arguments: ["", " ", "\n", "\u{00A0}"])
    func blankNoteEndToEnd(_ typed: String) async throws {
        guard case .valid(let instruction) = SendValidation.validate(phone: "08031234567", amountText: "1500", note: typed) else {
            Issue.record("invalid"); return
        }
        let rig = Rig(.json(Wire.transferred, status: 201))
        _ = await rig.transfer(instruction)
        let (text, _) = try body(rig)
        #expect(!text.contains("note"))
    }

    @Test("POSTs to /api/wallet/transfer with the Idempotency-Key, as JSON, kobo as an integer")
    func request() async throws {
        let rig = Rig(.json(Wire.transferred, status: 201))
        _ = await rig.transfer(WK.instruction(amountKobo: 150_050))
        let sent = try #require(rig.sent.first)
        #expect(sent.request.method == .post)
        #expect(sent.request.path == "/api/wallet/transfer")
        #expect(sent.operationID == "transferMoney")
        #expect(sent.request.headerFields[.init("Idempotency-Key")!] == key)
        #expect(sent.request.headerFields[.contentType]?.hasPrefix("application/json") == true)
        let compact = sent.bodyText.filter { !$0.isWhitespace }
        #expect(compact.contains("\"amountKobo\":150050"))
        #expect(!compact.contains("1500.5"))
    }

    // Lesson 9. The token goes to the API origin and nowhere else.
    @Test("the session token rides on the transfer, the balance and the activity, as a bearer header")
    func tokenCarried() async throws {
        let rig = Rig(.json(Wire.transferred, status: 201))
        _ = await rig.transfer()
        let walletRig = Rig(.json(Wire.wallet()))
        _ = await walletRig.wallet()
        let activityRig = Rig(.json(Wire.page(items: [])))
        _ = await activityRig.activity()
        for sent in [rig.sent, walletRig.sent, activityRig.sent].compactMap(\.first) {
            #expect(sent.request.headerFields[.authorization] == "Bearer \(Fixture.tokenA.reveal())", "\(sent.operationID)")
        }
    }

    @Test("a client pointed at another origin than the token's does not send the token")
    func tokenOnlyToTheAPIOrigin() async throws {
        let rig = Rig(.json(Wire.transferred, status: 201), tokenOrigin: "https://other.example.test")
        _ = await rig.transfer()
        _ = await rig.wallet()
        _ = await rig.activity()
        #expect(rig.sent.count == 3)
        for sent in rig.sent { #expect(sent.request.headerFields[.authorization] == nil, "\(sent.operationID)") }
    }

    @Test("a signed-out store sends no header, and nothing about the body carries the token")
    func noTokenNoHeader() async throws {
        let rig = Rig(.json(Wire.transferred, status: 201), token: nil)
        _ = await rig.transfer()
        let sent = try #require(rig.sent.first)
        #expect(sent.request.headerFields[.authorization] == nil)
        let carrying = Rig(.json(Wire.transferred, status: 201))
        _ = await carrying.transfer()
        #expect(!carrying.sent[0].bodyText.contains(Fixture.tokenA.reveal()))
    }

    @Test("201 is a receipt: the posting, signed from the sender's side, and the sender's wallet with its asOf")
    func created() async {
        let result = await Rig(.json(Wire.transferred, status: 201)).transfer()
        guard case .success(let receipt) = result else { Issue.record("\(result)"); return }
        #expect(receipt.activity.id == "pst_1")
        #expect(receipt.activity.kind == .transfer)
        #expect(receipt.activity.amountKobo == -150_000)
        #expect(receipt.activity.counterparty == "Ada Obi")
        #expect(receipt.activity.note == nil)
        #expect(receipt.wallet.balanceKobo == 4_850_000)
        #expect(receipt.wallet.asOf == Date(timeIntervalSince1970: 1_791_454_530))
    }

    @Test("a reply that breaks the contract is an unreadable reply, never a half-trusted one", arguments: [
        ("a float balance", "{\"transaction\":\(Wire.transaction()),\"wallet\":\(Wire.wallet(balance: "4850000.5"))}"),
        ("a float amount", "{\"transaction\":\(Wire.transaction(amount: "-1500.5")),\"wallet\":\(Wire.wallet())}"),
        ("a currency other than naira", "{\"transaction\":\(Wire.transaction()),\"wallet\":\(Wire.wallet(currency: "USD"))}"),
        ("a kind this build does not know", "{\"transaction\":\(Wire.transaction(kind: "refund")),\"wallet\":\(Wire.wallet())}"),
        ("a posting id that is not one", "{\"transaction\":\(Wire.transaction(id: "pst 1!")),\"wallet\":\(Wire.wallet())}"),
        ("an account id that is not one", "{\"transaction\":\(Wire.transaction()),\"wallet\":{\"accountId\":\"a b\",\"currency\":\"NGN\",\"balanceKobo\":1,\"asOf\":\"2026-10-08T10:15:30.000Z\"}}"),
        ("a date that is not one", "{\"transaction\":\(Wire.transaction(createdAt: "yesterday")),\"wallet\":\(Wire.wallet())}"),
        ("a missing wallet", "{\"transaction\":\(Wire.transaction())}"),
        ("not JSON", "<html>ok</html>"),
        ("an empty body", ""),
    ])
    func unreadable(_ name: String, _ reply: String) async {
        let result = await Rig(.json(reply, status: 201)).transfer()
        #expect(result == .failure(.undecodableResponse), "\(name)")
    }

    @Test("a 2xx other than 201 is not a posted transfer, whatever its body")
    func other2xx() async {
        #expect(await Rig(.json(Wire.transferred, status: 200)).transfer() == .failure(.undecodableResponse))
        #expect(await Rig(.json(Wire.transferred, status: 202)).transfer() == .failure(.undecodableResponse))
    }

    @Test("a redirect is an unexpected reply, even when its body looks like a refusal")
    func redirect() async {
        #expect(await Rig(.json(Payloads.apiError("not_found", "x"), status: 302)).transfer() == .failure(.unexpectedResponse(status: 302)))
    }

    @Test("a 5xx error page is an unexpected reply")
    func errorPage() async {
        let page = StubTransport(reply: .respond(status: 502, contentType: "text/html", body: "<html>Bad gateway</html>"))
        #expect(await Rig(page).transfer() == .failure(.unexpectedResponse(status: 502)))
    }

    @Test("a dropped connection is unreachable, and exactly ONE request was made: nothing retries")
    func droppedConnectionOneRequest() async {
        for code in [URLError.Code.networkConnectionLost, .timedOut, .notConnectedToInternet, .cannotConnectToHost] {
            let rig = Rig(StubTransport(reply: .fail(URLError(code))))
            #expect(await rig.transfer() == .failure(.unreachable(code)))
            #expect(rig.sent.count == 1)
        }
    }

    @Test("the server's refusals arrive parsed, with moneyMoved and fields")
    func refusals() async {
        let insufficient = Payloads.apiError("insufficient_funds", "Insufficient wallet balance.", extra: ",\"moneyMoved\":false")
        guard case .failure(.server(let error)) = await Rig(.json(insufficient, status: 422)).transfer() else { Issue.record("422"); return }
        #expect(error.code == .insufficient_funds && error.status == 422 && error.moneyMoved == false)

        let own = Payloads.apiError(
            "validation_failed", "You cannot transfer money to yourself.",
            extra: ",\"moneyMoved\":false,\"fields\":{\"toPhone\":[\"cannot transfer to yourself\"]}")
        guard case .failure(.server(let selfTransfer)) = await Rig(.json(own, status: 400)).transfer() else { Issue.record("400"); return }
        #expect(selfTransfer.fieldErrors["toPhone"] == [TransferVerdict.ownNumberFieldMessage])

        let pipe = Payloads.apiError("validation_failed", "Validation failed.", extra: ",\"fields\":{\"amountKobo\":[\"Too small\"]}")
        guard case .failure(.server(let invalid)) = await Rig(.json(pipe, status: 400)).transfer() else { Issue.record("pipe"); return }
        #expect(invalid.moneyMoved == nil, "the body validation runs before anything is recorded and does not say")
    }

    @Test("a 429 carries Retry-After")
    func rateLimited() async {
        var transport = StubTransport.json(Payloads.apiError("rate_limited", "Slow down."), status: 429)
        transport.responseHeaders = [.retryAfter: "30"]
        guard case .failure(.server(let error)) = await Rig(transport).transfer() else { Issue.record("429"); return }
        #expect(error.retryAfterSeconds == 30)
    }

    @Test("a reply through the whole path: the verdict of a wire refusal is the stored-answer rule")
    func endToEndVerdict() async {
        let insufficient = Payloads.apiError("insufficient_funds", "Insufficient wallet balance.", extra: ",\"moneyMoved\":false")
        let result = await Rig(.json(insufficient, status: 422)).transfer()
        #expect(TransferVerdict.of(result, instruction: WK.instruction(), firstEverSend: false) == .settled(.insufficientFunds))
        let unauthenticated = await Rig(.json(Payloads.apiError("unauthenticated", "Sign in."), status: 401)).transfer()
        #expect(TransferVerdict.of(unauthenticated, instruction: WK.instruction(), firstEverSend: false) == .unsettled(.sessionEnded))
    }
}

@Suite("Wallet reads on the wire")
struct WalletReadWireTests {
    @Test("GET /api/wallet maps the balance, signed, with its asOf")
    func wallet() async throws {
        let rig = Rig(.json(Wire.wallet(balance: "-5")))
        let result = await rig.wallet()
        guard case .success(let balance) = result else { Issue.record("\(result)"); return }
        #expect(balance.balanceKobo == -5)
        #expect(balance.accountId == "acc_one")
        let sent = try #require(rig.sent.first)
        #expect(sent.request.method == .get && sent.request.path == "/api/wallet" && sent.operationID == "getWallet")
    }

    @Test("a wallet reply that breaks the contract is unreadable", arguments: [
        Wire.wallet(balance: "1.5"), Wire.wallet(currency: "GBP"), Wire.wallet(asOf: "soon"), "{}", "[]",
    ])
    func unreadableWallet(_ reply: String) async {
        #expect(await Rig(.json(reply)).wallet() == .failure(.undecodableResponse))
    }

    @Test("GET /api/wallet/transactions sends the cursor and a page size, and maps nulls")
    func activity() async throws {
        let rig = Rig(.json(Wire.page(items: [Wire.transaction(), Wire.transaction(id: "pst_2", kind: "topup", amount: "1000000", counterparty: "null", note: "\"Hi\"")], next: "\"c2\"")))
        let result = await rig.activity(cursor: "c1")
        guard case .success(let page) = result else { Issue.record("\(result)"); return }
        #expect(page.items.map(\.id) == ["pst_1", "pst_2"])
        #expect(page.items[1].kind == .topUp && page.items[1].counterparty == nil && page.items[1].note == "Hi")
        #expect(page.nextCursor == "c2")
        let sent = try #require(rig.sent.first)
        #expect(sent.request.path?.hasPrefix("/api/wallet/transactions?") == true)
        #expect(sent.request.path?.contains("cursor=c1") == true)
        #expect(sent.request.path?.contains("limit=20") == true)
    }

    @Test("the first page sends no cursor")
    func firstPage() async throws {
        let rig = Rig(.json(Wire.page(items: [])))
        _ = await rig.activity()
        let sent = try #require(rig.sent.first)
        #expect(sent.request.path?.contains("cursor") == false)
    }

    @Test("one bad row makes the page unreadable rather than silently dropping a transaction", arguments: [
        Wire.page(items: [Wire.transaction(), Wire.transaction(id: "bad id")]),
        Wire.page(items: [Wire.transaction(amount: "1.5")]),
        Wire.page(items: [Wire.transaction(kind: "gift")]),
    ])
    func badRow(_ reply: String) async {
        #expect(await Rig(.json(reply)).activity() == .failure(.undecodableResponse))
    }

    @Test("a 401 on a read is reported to the session by the middleware and arrives as an unauthenticated refusal")
    func unauthenticatedRead() async {
        let result = await Rig(.json(Payloads.apiError("unauthenticated", "Sign in."), status: 401)).wallet()
        guard case .failure(let error) = result else { Issue.record("\(result)"); return }
        #expect(error.isUnauthenticated)
        #expect(WalletReadProblem(error) == .sessionEnded)
    }
}
