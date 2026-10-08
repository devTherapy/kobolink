import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import KobolinkKit

private let key = "11111111-1111-4111-8111-000000000001"

private enum Wire {
    static let started = """
        {"reference":"kbl_aBcDeFgHjK","code":"aBcDeFgH","amountKobo":1850000,"currency":"NGN",\
        "status":"pending","createdAt":"2026-10-08T10:15:30.000Z"}
        """

    /// `verify`'s 200: the wire `Payment`, which carries the payer's name and a masked email (the app drops both).
    static func payment(
        status: String = "success", moneyMoved: Bool = true, reason: String = "null",
        reference: String = "kbl_aBcDeFgHjK", code: String = "aBcDeFgH", amount: String = "1850000"
    ) -> String {
        """
        {"payment":{"reference":"\(reference)","code":"\(code)","amountKobo":\(amount),"currency":"NGN","status":"\(status)",\
        "payerName":"Ngozi Okafor","payerEmail":"n***@example.test","createdAt":"2026-10-08T10:15:30.000Z",\
        "completedAt":\(status == "success" ? "\"2026-10-08T10:15:31.000Z\"" : "null"),"failureReason":\(reason),"moneyMoved":\(moneyMoved)}}
        """
    }

    static func link(
        state: String = "payable", amount: String = "1850000", description: String = "\"Size 12\"", expiresAt: String = "null"
    ) -> String {
        """
        {"state":"\(state)","link":{"code":"aBcDeFgH","merchantName":"Adebayo Stores","title":"Ankara Two-Piece Set",\
        "description":\(description),"amountKobo":\(amount),"currency":"NGN","isReusable":false,"expiresAt":\(expiresAt)}}
        """
    }
}

/// A client with the real middleware and a merchant's token in the store, so every test of a payer's call is
/// also a test that the token does not ride along.
private struct Rig {
    let transport: StubTransport
    let client: KobolinkAPIClient

    init(_ transport: StubTransport, token: SessionToken? = Fixture.tokenA) {
        self.transport = transport
        let store = InMemoryTokenStore(token: token)
        client = KobolinkAPIClient(
            configuration: APIConfiguration(baseURL: URL(string: "https://pay.example.test")!),
            transport: transport,
            middlewares: [
                AuthMiddleware(baseURL: URL(string: "https://pay.example.test")!, tokenStore: store, relay: SessionRejectionRelay())
            ]
        )
    }

    var sent: [RequestRecorder.Entry] { transport.recorder.all }

    func initialize(_ request: InitializeRequest = CK.request()) async -> Result<StartedCheckout, APIError> {
        do throws(APIError) {
            return .success(try await client.initializeCheckout(request, idempotencyKey: key))
        } catch {
            return .failure(error)
        }
    }

    func lookup() async -> Result<LinkLookup, APIError> {
        do throws(APIError) {
            return .success(try await client.lookupLink(code: CK.codeA))
        } catch {
            return .failure(error)
        }
    }

    func verify(_ reference: String = CK.reference) async -> Result<VerifiedPayment, APIError> {
        do throws(APIError) {
            return .success(try await client.verifyCheckout(reference: reference, idempotencyKey: key))
        } catch {
            return .failure(error)
        }
    }
}

@Suite("Checkout client: verify on the wire")
struct VerifyWireTests {
    @Test("POSTs only the reference as JSON to /api/checkout/verify with the Idempotency-Key header")
    func request() async throws {
        let rig = Rig(.json(Wire.payment()))
        _ = await rig.verify()
        let sent = try #require(rig.sent.first)
        #expect(sent.request.method == .post)
        #expect(sent.request.path == "/api/checkout/verify")
        #expect(sent.operationID == "verifyCheckout")
        #expect(sent.request.headerFields[.init("Idempotency-Key")!] == key)
        #expect(sent.request.headerFields[.contentType]?.hasPrefix("application/json") == true)
        let json = try #require(JSONSerialization.jsonObject(with: Data(sent.bodyText.utf8)) as? [String: Any])
        #expect(json as NSDictionary == ["reference": "kbl_aBcDeFgHjK"] as NSDictionary)
    }

    @Test("verifyCheckout is a public operation: no Authorization header and no cookie, even with a merchant's token on the phone")
    func noMerchantCredential() async throws {
        let rig = Rig(.json(Wire.payment()), token: Fixture.tokenA)
        _ = await rig.verify()
        let sent = try #require(rig.sent.first)
        #expect(sent.operationID == "verifyCheckout")
        #expect(sent.request.headerFields[.authorization] == nil)
        #expect(sent.request.headerFields[.cookie] == nil)
        #expect(!sent.bodyText.contains(Fixture.tokenA.reveal()))
        // ... and not on any other reply either: a 401 from a proxy does not make it a secured call.
        let refused = Rig(.json(Payloads.apiError("unauthenticated", "Sign in."), status: 401), token: Fixture.tokenA)
        _ = await refused.verify()
        #expect(refused.sent.first?.request.headerFields[.authorization] == nil)
    }

    @Test("a 401 to verify is NOT reported as the merchant's session ending")
    func unauthorisedIsNotASessionEnd() async {
        let store = InMemoryTokenStore(token: Fixture.tokenA)
        let rejected = Captured<Int>(0)
        let relay = SessionRejectionRelay()
        relay.handler = { _ in rejected.value += 1 }
        let client = KobolinkAPIClient(
            configuration: APIConfiguration(baseURL: URL(string: "https://pay.example.test")!),
            transport: StubTransport.json(Payloads.apiError("unauthenticated", "Sign in."), status: 401),
            middlewares: [AuthMiddleware(baseURL: URL(string: "https://pay.example.test")!, tokenStore: store, relay: relay)]
        )
        _ = try? await client.verifyCheckout(reference: CK.reference, idempotencyKey: key)
        #expect(rejected.value == 0)
    }

    @Test("200 success is a paid payment: integer kobo, the reference, money moved; and no payer name or email is kept")
    func success() async {
        let result = await Rig(.json(Wire.payment())).verify()
        guard case .success(let payment) = result else { Issue.record("\(result)"); return }
        #expect(payment == VerifiedPayment(reference: CK.reference, code: CK.codeA, amountKobo: 1_850_000, status: .success, moneyMoved: true))
        let described = String(describing: payment) + String(reflecting: payment)
        #expect(!described.contains("Ngozi") && !described.contains("Okafor") && !described.contains("example.test"))
    }

    @Test("200 failed carries the reason and money not moved; a blank reason is none")
    func failed() async {
        let declined = await Rig(.json(Wire.payment(status: "failed", moneyMoved: false, reason: "\"Card declined by the simulated gateway.\""))).verify()
        #expect(declined == .success(CK.declined))
        let blank = await Rig(.json(Wire.payment(status: "failed", moneyMoved: false, reason: "\"  \""))).verify()
        #expect(blank == .success(CK.payment(.failed)))
        let none = await Rig(.json(Wire.payment(status: "failed", moneyMoved: false))).verify()
        #expect(none == .success(CK.payment(.failed)))
    }

    @Test("200 pending is pending, with money not moved")
    func pending() async {
        #expect(await Rig(.json(Wire.payment(status: "pending", moneyMoved: false))).verify() == .success(CK.stillPending))
    }

    @Test("a reply that breaks the contract's invariant is unreadable, never a payment: money moved must equal status success")
    func invariant() async {
        for body in [
            Wire.payment(status: "success", moneyMoved: false),
            Wire.payment(status: "failed", moneyMoved: true, reason: "\"x\""),
            Wire.payment(status: "pending", moneyMoved: true),
        ] {
            #expect(await Rig(.json(body)).verify() == .failure(.undecodableResponse), "\(body)")
        }
    }

    @Test("a reference or code that is not one, a float amount, a status this build does not know: all unreadable")
    func malformed() async {
        for body in [
            Wire.payment(reference: "kbl_short"),
            Wire.payment(reference: "kbl_aBcDeFgH0K"),
            Wire.payment(code: "short"),
            Wire.payment(amount: "1850.5"),
            Wire.payment(status: "refunded"),
            "{}", "{\"payment\":null}", "not json",
        ] {
            #expect(await Rig(.json(body)).verify() == .failure(.undecodableResponse), "\(body)")
        }
    }

    @Test("a 2xx other than 200 is not a payment, whatever its body")
    func other2xx() async {
        #expect(await Rig(.json(Wire.payment(), status: 201)).verify() == .failure(.undecodableResponse))
        #expect(await Rig(.json(Wire.payment(), status: 202)).verify() == .failure(.undecodableResponse))
    }

    @Test("a redirect is an unexpected reply, and nothing is followed")
    func redirect() async {
        #expect(await Rig(.json(Payloads.apiError("not_found", "x", extra: ",\"moneyMoved\":false"), status: 302)).verify() == .failure(.unexpectedResponse(status: 302)))
    }

    @Test("an error page is an unexpected reply, a dropped connection is unreachable, and exactly ONE request is made")
    func transportFailures() async {
        let page = StubTransport(reply: .respond(status: 502, contentType: "text/html", body: "<html>Bad gateway</html>"))
        #expect(await Rig(page).verify() == .failure(.unexpectedResponse(status: 502)))
        for code in [URLError.Code.networkConnectionLost, .timedOut, .notConnectedToInternet] {
            let rig = Rig(StubTransport(reply: .fail(URLError(code))))
            #expect(await rig.verify() == .failure(.unreachable(code)))
            #expect(rig.sent.count == 1)
        }
    }

    @Test("a parsed not_found carries moneyMoved false; a 429 carries Retry-After; link_not_payable carries its state")
    func refusals() async {
        let notFound = Payloads.apiError("not_found", "No checkout with that reference.", extra: ",\"moneyMoved\":false")
        guard case .failure(.server(let missing)) = await Rig(.json(notFound, status: 404)).verify() else { Issue.record("404"); return }
        #expect(missing.code == .not_found && missing.status == 404 && missing.moneyMoved == false)

        var limited = StubTransport.json(Payloads.apiError("rate_limited", "Slow down."), status: 429)
        limited.responseHeaders = [.retryAfter: "30"]
        guard case .failure(.server(let slow)) = await Rig(limited).verify() else { Issue.record("429"); return }
        #expect(slow.retryAfterSeconds == 30)

        let notPayable = Payloads.apiError("link_not_payable", "No.", extra: ",\"moneyMoved\":false,\"state\":\"already-paid\"")
        guard case .failure(.server(let paid)) = await Rig(.json(notPayable, status: 409)).verify() else { Issue.record("409"); return }
        #expect(paid.linkState == .already_hyphen_paid)
    }
}

@Suite("Checkout client: initialize on the wire")
struct InitializeWireTests {
    @Test("POSTs the exact request as JSON to /api/checkout/initialize with the Idempotency-Key header")
    func request() async throws {
        let rig = Rig(.json(Wire.started, status: 201))
        _ = await rig.initialize(CK.request(amountKobo: 1_850_050, name: "Ngozi Okafor", email: "ngozi@example.test"))
        let sent = try #require(rig.sent.first)
        #expect(sent.request.method == .post)
        #expect(sent.request.path == "/api/checkout/initialize")
        #expect(sent.operationID == "initializeCheckout")
        #expect(sent.request.headerFields[.init("Idempotency-Key")!] == key)
        #expect(sent.request.headerFields[.contentType]?.hasPrefix("application/json") == true)
        let json = try #require(JSONSerialization.jsonObject(with: Data(sent.bodyText.utf8)) as? [String: Any])
        #expect(json["code"] as? String == "aBcDeFgH")
        #expect(json["amountKobo"] as? Int == 1_850_050)
        #expect(json["payerName"] as? String == "Ngozi Okafor")
        #expect(json["payerEmail"] as? String == "ngozi@example.test")
        #expect(Set(json.keys) == ["code", "amountKobo", "payerName", "payerEmail"])
        // Kobo go out as an integer, never as 18500.5.
        #expect(sent.bodyText.filter { !$0.isWhitespace }.contains("\"amountKobo\":1850050,") || sent.bodyText.filter { !$0.isWhitespace }.contains("\"amountKobo\":1850050}"))
    }

    @Test("a payer's payment carries no Authorization header and no cookie, even with a merchant's token on the phone")
    func noMerchantCredential() async throws {
        let rig = Rig(.json(Wire.started, status: 201), token: Fixture.tokenA)
        _ = await rig.initialize()
        let sent = try #require(rig.sent.first)
        #expect(sent.request.headerFields[.authorization] == nil)
        #expect(sent.request.headerFields[.cookie] == nil)
        #expect(!sent.bodyText.contains(Fixture.tokenA.reveal()))
    }

    @Test("201 is a started checkout with its reference, amount and code")
    func created() async {
        let result = await Rig(.json(Wire.started, status: 201)).initialize()
        guard case .success(let started) = result else { Issue.record("\(result)"); return }
        #expect(started.reference == "kbl_aBcDeFgHjK")
        #expect(started.code == CK.codeA)
        #expect(started.amountKobo == 1_850_000)
    }

    @Test("a reference that is not one, or a code that is not one, is an unreadable reply")
    func invalidReply() async {
        for body in [
            Wire.started.replacingOccurrences(of: "kbl_aBcDeFgHjK", with: "kbl_short"),
            Wire.started.replacingOccurrences(of: "kbl_aBcDeFgHjK", with: "xyz_aBcDeFgHjK"),
            Wire.started.replacingOccurrences(of: "kbl_aBcDeFgHjK", with: "kbl_aBcDeFgH0K"),
            Wire.started.replacingOccurrences(of: "\"code\":\"aBcDeFgH\"", with: "\"code\":\"short\""),
        ] {
            #expect(await Rig(.json(body, status: 201)).initialize() == .failure(.undecodableResponse))
        }
    }

    @Test("a float amount on the wire is refused, never rounded")
    func floatAmountIsUndecodable() async {
        let body = Wire.started.replacingOccurrences(of: "\"amountKobo\":1850000", with: "\"amountKobo\":1850.5")
        #expect(await Rig(.json(body, status: 201)).initialize() == .failure(.undecodableResponse))
        let link = Wire.link(amount: "1850.5")
        #expect(await Rig(.json(link)).lookup() == .failure(.undecodableResponse))
    }

    @Test("a 2xx other than 201 is not a started checkout, whatever its body")
    func other2xx() async {
        #expect(await Rig(.json(Wire.started, status: 200)).initialize() == .failure(.undecodableResponse))
        let refusalShaped = Payloads.apiError("conflict", "x")
        #expect(await Rig(.json(refusalShaped, status: 202)).initialize() == .failure(.undecodableResponse))
    }

    @Test("a redirect is an unexpected reply, even when its body looks like a refusal")
    func redirect() async {
        #expect(await Rig(.json(Payloads.apiError("not_found", "x"), status: 302)).initialize() == .failure(.unexpectedResponse(status: 302)))
    }

    @Test("a 5xx error page is an unexpected reply")
    func errorPage() async {
        let page = StubTransport(reply: .respond(status: 502, contentType: "text/html", body: "<html>Bad gateway</html>"))
        #expect(await Rig(page).initialize() == .failure(.unexpectedResponse(status: 502)))
    }

    @Test("a dropped connection is unreachable, and exactly ONE request was made: nothing retries")
    func droppedConnectionOneRequest() async {
        for code in [URLError.Code.networkConnectionLost, .timedOut, .notConnectedToInternet, .cannotConnectToHost] {
            let rig = Rig(StubTransport(reply: .fail(URLError(code))))
            #expect(await rig.initialize() == .failure(.unreachable(code)))
            #expect(rig.sent.count == 1)
        }
    }

    @Test("the server's refusals arrive parsed, with moneyMoved, fields and the link state")
    func refusals() async throws {
        let linkNotPayable = Payloads.apiError("link_not_payable", "This link cannot be paid right now.", extra: ",\"moneyMoved\":false,\"state\":\"expired\"")
        guard case .failure(.server(let notPayable)) = await Rig(.json(linkNotPayable, status: 409)).initialize() else {
            Issue.record("link_not_payable"); return
        }
        #expect(notPayable.code == .link_not_payable && notPayable.status == 409)
        #expect(notPayable.moneyMoved == false)
        #expect(notPayable.linkState == .expired)

        let mismatch = Payloads.apiError("amount_mismatch", "That amount does not match this link.", extra: ",\"moneyMoved\":false")
        guard case .failure(.server(let amount)) = await Rig(.json(mismatch, status: 422)).initialize() else { Issue.record("amount"); return }
        #expect(amount.code == .amount_mismatch && amount.status == 422 && amount.moneyMoved == false)

        let validation = Payloads.apiError("validation_failed", "Validation failed.", extra: ",\"fields\":{\"payerEmail\":[\"Invalid email address\"]}")
        guard case .failure(.server(let invalid)) = await Rig(.json(validation, status: 400)).initialize() else { Issue.record("validation"); return }
        #expect(invalid.fieldErrors == ["payerEmail": ["Invalid email address"]])
        #expect(invalid.moneyMoved == nil)
    }

    @Test("a 429 carries Retry-After")
    func rateLimited() async {
        var transport = StubTransport.json(Payloads.apiError("rate_limited", "Slow down."), status: 429)
        transport.responseHeaders = [.retryAfter: "30"]
        guard case .failure(.server(let error)) = await Rig(transport).initialize() else { Issue.record("429"); return }
        #expect(error.retryAfterSeconds == 30)
    }
}

@Suite("Checkout client: link lookup")
struct LookupWireTests {
    @Test("GETs /api/links/{code}/public with no credential")
    func request() async throws {
        let rig = Rig(.json(Wire.link()), token: Fixture.tokenA)
        _ = await rig.lookup()
        let sent = try #require(rig.sent.first)
        #expect(sent.request.method == .get)
        #expect(sent.request.path == "/api/links/aBcDeFgH/public")
        #expect(sent.request.headerFields[.authorization] == nil)
    }

    @Test("a payable fixed-amount link maps merchant, title, description and integer kobo")
    func payable() async {
        guard case .success(let lookup) = await Rig(.json(Wire.link())).lookup() else { Issue.record("lookup"); return }
        #expect(lookup.availability == .payable)
        #expect(lookup.link == CheckoutLink(code: CK.codeA, merchantName: "Adebayo Stores", title: "Ankara Two-Piece Set", description: "Size 12", amountKobo: 1_850_000, isReusable: false, expiresAt: nil))
    }

    @Test("each wire state maps to its availability")
    func states() async {
        for (wire, expected) in [("payable", LinkAvailability.payable), ("disabled", .disabled), ("expired", .expired), ("already-paid", .alreadyPaid)] {
            guard case .success(let lookup) = await Rig(.json(Wire.link(state: wire))).lookup() else { Issue.record(Comment(rawValue: wire)); continue }
            #expect(lookup.availability == expected)
        }
    }

    @Test("a state this build does not know is an unreadable reply, never a payable link")
    func unknownState() async {
        #expect(await Rig(.json(Wire.link(state: "paused"))).lookup() == .failure(.undecodableResponse))
    }

    @Test("an open-amount link has no amount; a blank description is none; an expiry is a date")
    func openAmount() async {
        let body = Wire.link(amount: "null", description: "\"   \"", expiresAt: "\"2026-10-07T17:00:00.000Z\"")
        guard case .success(let lookup) = await Rig(.json(body)).lookup() else { Issue.record("lookup"); return }
        #expect(lookup.link.amountKobo == nil)
        #expect(lookup.link.description == nil)
        #expect(lookup.link.expiresAt == Date(timeIntervalSince1970: 1_791_392_400))
    }

    @Test("a reply for a different code than the one asked is not trusted")
    func wrongCode() async {
        let body = Wire.link().replacingOccurrences(of: "\"code\":\"aBcDeFgH\"", with: "\"code\":\"short\"")
        #expect(await Rig(.json(body)).lookup() == .failure(.undecodableResponse))
    }

    @Test("a parsed not_found is a server refusal; an HTML 404 is an unexpected reply")
    func notFound() async {
        guard case .failure(.server(let error)) = await Rig(.json(Payloads.apiError("not_found", "No link with that code."), status: 404)).lookup() else {
            Issue.record("not_found"); return
        }
        #expect(error.code == .not_found)
        let page = StubTransport(reply: .respond(status: 404, contentType: "text/html", body: "<html>Not found</html>"))
        #expect(await Rig(page).lookup() == .failure(.unexpectedResponse(status: 404)))
    }
}

@Suite("Idempotency keys")
struct IdempotencyKeyTests {
    @Test("a generated key is valid and different each time")
    func generated() {
        let keys = (0..<50).map { _ in IdempotencyKey.make() }
        #expect(Set(keys).count == 50)
        #expect(keys.allSatisfy(IdempotencyKey.isValid))
    }

    @Test("the validity rule is the contract's: 16 to 128 of A-Z a-z 0-9 _ -")
    func rule() {
        #expect(IdempotencyKey.isValid(String(repeating: "a", count: 16)))
        #expect(IdempotencyKey.isValid(String(repeating: "a", count: 128)))
        #expect(!IdempotencyKey.isValid(String(repeating: "a", count: 15)))
        #expect(!IdempotencyKey.isValid(String(repeating: "a", count: 129)))
        #expect(!IdempotencyKey.isValid("aaaaaaaaaaaaaaa!"))
        #expect(!IdempotencyKey.isValid("aaaaaaaaaaaaaaaé"))
        #expect(IdempotencyKey.isValid("aaaa_aaaa-aaaa_AAAA"))
    }
}
