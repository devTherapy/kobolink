import Foundation
import Testing

@testable import KobolinkKit

/// The app's own client, against the REAL apps/api and a real Postgres (feature X2, iOS half).
///
/// OFF by default. These tests run only when `KOBOLINK_REAL_API` names a running API, for example
///
///     ./scripts/ios-real-api-smoke.sh up           # prints http://localhost:<port>
///     KOBOLINK_REAL_API=http://localhost:<port> swift test --package-path mobile/ios/KobolinkKit --filter RealAPIIntegration
///     ./scripts/ios-real-api-smoke.sh down
///
/// See mobile/ios/README.md, "Running against the real API". With the variable unset the suite is
/// skipped and every test says why, so a plain `swift test` / `xcodebuild test` stays hermetic and CI
/// (no Docker on the iOS job yet) never needs a server.
///
/// Users, links and funds are created through the API itself (register, create link, top up) with
/// invented names and passwords generated per run; nothing is read from or written to a file.
/// The app calls under test go through `KobolinkAPIClient` with the real `AuthMiddleware`.
private let realAPI = ProcessInfo.processInfo.environment["KOBOLINK_REAL_API"].flatMap { URL(string: $0) }

@Suite(
    "Real API (opt-in: set KOBOLINK_REAL_API, see mobile/ios/README.md)",
    .serialized,
    .enabled(if: realAPI != nil, "Skipped: KOBOLINK_REAL_API is not set. Start the stack with scripts/ios-real-api-smoke.sh up.")
)
struct RealAPIIntegrationTests {
    let world: RealWorld

    init() async throws {
        world = try await WorldCache.shared.world()
    }

    // MARK: Login and the session

    @Test("login as a mobile client returns a token and a user; a wrong password is a 401 unauthenticated")
    func login() async throws {
        let client = world.anonymousClient()
        let session = try await client.login(email: world.customer.email, password: world.customer.password)
        #expect(session.token != nil)
        #expect(session.user.role == .customer)
        #expect(session.user.email == world.customer.email)

        let error = await apiError { _ = try await client.login(email: world.customer.email, password: "not-the-password") }
        guard case .server(let refusal) = error else { Issue.record("expected a server refusal, got \(String(describing: error))"); return }
        #expect(refusal.status == 401)
        #expect(refusal.code == .unauthenticated)
        #expect(error?.isUnauthenticated == true)
    }

    @Test("the rate limit is a 429 with a numeric Retry-After the app reads")
    func rateLimit() async throws {
        let client = world.anonymousClient()
        let email = "ratelimit-\(UUID().uuidString.prefix(8).lowercased())@x2.example.test"
        var last: APIError?
        // Five attempts are admitted (and each reserves one of the per-IP slots); the sixth is refused.
        for _ in 1...6 {
            last = await apiError { _ = try await client.login(email: email, password: "wrong-wrong-wrong") }
        }
        guard case .server(let refusal)? = last else { Issue.record("expected a refusal, got \(String(describing: last))"); return }
        #expect(refusal.status == 429)
        #expect(refusal.code == .rate_limited)
        #expect(refusal.retryAfterSeconds != nil)
    }

    @Test("me with the stored token, and a revoked token is rejected and reported")
    func meAndLogout() async throws {
        let signedIn = try await world.signedInClient(world.customer)
        let me = try await signedIn.client.currentUser()
        #expect(me.id == signedIn.user.id)
        try await signedIn.client.logout(revoking: signedIn.token)
        let error = await apiError { _ = try await signedIn.client.currentUser() }
        #expect(error?.isUnauthenticated == true)
    }

    // MARK: Checkout (the payer's calls: no token)

    @Test("an open-amount and a fixed link resolve; an unknown code is 404")
    func publicLinks() async throws {
        let client = world.anonymousClient()
        let fixed = try await client.lookupLink(code: LinkCode(world.fixedLink)!)
        #expect(fixed.availability == .payable)
        #expect(fixed.link.amountKobo == 250_000)
        #expect(fixed.link.description == "Delivery in Lagos within 3 days.")
        let open = try await client.lookupLink(code: LinkCode(world.openLink)!)
        #expect(open.link.amountKobo == nil)
        let error = await apiError { _ = try await client.lookupLink(code: LinkCode("ZZZZZZZZ")!) }
        guard case .server(let refusal)? = error else { Issue.record("expected not_found, got \(String(describing: error))"); return }
        #expect(refusal.status == 404)
        #expect(refusal.code == .not_found)
    }

    @Test("pay: initialize, replay the same key, verify: success; a decided reference answers the same under a new key")
    func paySuccess() async throws {
        let client = world.anonymousClient()
        let request = InitializeRequest(code: LinkCode(world.fixedLink)!, amountKobo: 250_000, payerName: "Ada Payer", payerEmail: "ada@example.test")
        let key = IdempotencyKey.make()
        let started = try await client.initializeCheckout(request, idempotencyKey: key)
        let replay = try await client.initializeCheckout(request, idempotencyKey: key)
        #expect(started == replay)

        let verifyKey = IdempotencyKey.make()
        let paid = try await client.verifyCheckout(reference: started.reference, idempotencyKey: verifyKey)
        #expect(paid.status == .success)
        #expect(paid.moneyMoved)
        #expect(paid.amountKobo == 250_000)
        let again = try await client.verifyCheckout(reference: started.reference, idempotencyKey: IdempotencyKey.make())
        #expect(again == paid)
    }

    @Test("a fail@ payer is declined: 200 failed, moneyMoved false, with the server's reason")
    func payDeclined() async throws {
        let client = world.anonymousClient()
        let request = InitializeRequest(code: LinkCode(world.openLink)!, amountKobo: 70_000, payerName: "Fay Ledger", payerEmail: "fail@example.test")
        let started = try await client.initializeCheckout(request, idempotencyKey: IdempotencyKey.make())
        let result = try await client.verifyCheckout(reference: started.reference, idempotencyKey: IdempotencyKey.make())
        #expect(result.status == .failed)
        #expect(!result.moneyMoved)
        #expect(result.failureReason == "Card declined by the simulated gateway.")
    }

    @Test("refusals the idempotency layer stores carry the statuses the app's verdict table expects")
    func initializeRefusals() async throws {
        let client = world.anonymousClient()
        let mismatch = InitializeRequest(code: LinkCode(world.fixedLink)!, amountKobo: 250_001, payerName: "Ada Payer", payerEmail: "ada@example.test")
        var error = await apiError { _ = try await client.initializeCheckout(mismatch, idempotencyKey: IdempotencyKey.make()) }
        guard case .server(let amount)? = error else { Issue.record("expected amount_mismatch, got \(String(describing: error))"); return }
        #expect(amount.status == 422)
        #expect(amount.code == .amount_mismatch)
        #expect(amount.moneyMoved == false)

        let disabled = InitializeRequest(code: LinkCode(world.disabledLink)!, amountKobo: 100_000, payerName: "Ada Payer", payerEmail: "ada@example.test")
        error = await apiError { _ = try await client.initializeCheckout(disabled, idempotencyKey: IdempotencyKey.make()) }
        guard case .server(let notPayable)? = error else { Issue.record("expected link_not_payable, got \(String(describing: error))"); return }
        #expect(notPayable.status == 409)
        #expect(notPayable.code == .link_not_payable)
        #expect(notPayable.linkState == .disabled)
        #expect(notPayable.moneyMoved == false)

        let key = IdempotencyKey.make()
        let first = InitializeRequest(code: LinkCode(world.fixedLink)!, amountKobo: 250_000, payerName: "Ada Payer", payerEmail: "ada@example.test")
        _ = try await client.initializeCheckout(first, idempotencyKey: key)
        let other = InitializeRequest(code: LinkCode(world.fixedLink)!, amountKobo: 250_000, payerName: "Someone Else", payerEmail: "ada@example.test")
        error = await apiError { _ = try await client.initializeCheckout(other, idempotencyKey: key) }
        guard case .server(let mismatchKey)? = error else { Issue.record("expected idempotency_mismatch, got \(String(describing: error))"); return }
        #expect(mismatchKey.status == 422)
        #expect(mismatchKey.code == .idempotency_mismatch)
    }

    // MARK: Wallet (the signed-in user's calls: bearer token)

    @Test("wallet, transfer with and without a note, replay, insufficient funds, activity")
    func walletJourney() async throws {
        let sender = try await world.signedInClient(world.customer)
        let before = try await sender.client.wallet()
        #expect(before.balanceKobo == RealWorld.openingBalanceKobo)

        // No note: the key is OMITTED from the body (the validator rejects null).
        let key = IdempotencyKey.make()
        let plain = TransferInstruction(toPhone: world.recipient.phone, amountKobo: 30_000, note: nil)
        let receipt = try await sender.client.transfer(plain, idempotencyKey: key)
        #expect(receipt.activity.amountKobo == -30_000)
        #expect(receipt.activity.note == nil)
        #expect(receipt.activity.counterparty == world.recipient.displayName)
        #expect(receipt.wallet.balanceKobo == RealWorld.openingBalanceKobo - 30_000)

        let replay = try await sender.client.transfer(plain, idempotencyKey: key)
        #expect(replay == receipt)
        #expect(try await sender.client.wallet().balanceKobo == RealWorld.openingBalanceKobo - 30_000)

        // With a note.
        let noted = try await sender.client.transfer(
            TransferInstruction(toPhone: world.recipient.phone, amountKobo: 10_000, note: "Lunch money"), idempotencyKey: IdempotencyKey.make())
        #expect(noted.activity.note == "Lunch money")

        // Same key, other amount.
        let error = await apiError {
            _ = try await sender.client.transfer(TransferInstruction(toPhone: world.recipient.phone, amountKobo: 40_000, note: nil), idempotencyKey: key)
        }
        guard case .server(let mismatch)? = error else { Issue.record("expected idempotency_mismatch, got \(String(describing: error))"); return }
        #expect(mismatch.code == .idempotency_mismatch)

        // More than the balance.
        let broke = await apiError {
            _ = try await sender.client.transfer(
                TransferInstruction(toPhone: world.recipient.phone, amountKobo: 999_999_999, note: nil), idempotencyKey: IdempotencyKey.make())
        }
        guard case .server(let insufficient)? = broke else { Issue.record("expected insufficient_funds, got \(String(describing: broke))"); return }
        #expect(insufficient.status == 422)
        #expect(insufficient.code == .insufficient_funds)
        #expect(insufficient.moneyMoved == false)

        // Activity: newest first, signed from this wallet's point of view.
        let page = try await sender.client.activity(cursor: nil)
        #expect(page.items.count >= 3)
        #expect(page.items.first?.note == "Lunch money")
        #expect(page.items.contains { $0.kind == .topUp && $0.amountKobo == RealWorld.openingBalanceKobo })
    }

    @Test("a wallet call without a token is 401 unauthenticated")
    func walletNeedsToken() async throws {
        let error = await apiError { _ = try await world.anonymousClient().wallet() }
        #expect(error?.isUnauthenticated == true)
    }
}

// MARK: - Helpers

/// What `perform` threw, if anything.
private func apiError(_ body: () async throws -> Void) async -> APIError? {
    do {
        try await body()
        return nil
    } catch let error as APIError {
        return error
    } catch {
        return .unreachable(.unknown)
    }
}

/// One world per run: the API's per-IP limiter (20 per 15 minutes) counts every register AND every login,
/// successful or not, so a world per test would lock this suite out of its own server.
actor WorldCache {
    static let shared = WorldCache()
    private var cached: RealWorld?

    func world() async throws -> RealWorld {
        if let cached { return cached }
        let base = try #require(realAPI)
        let made = try await RealWorld.make(baseURL: base)
        cached = made
        return made
    }
}

struct TestUser {
    let email: String
    let password: String
    let phone: String
    let displayName: String
}

/// The fixtures one run needs, created through the API with invented data.
struct RealWorld {
    static let openingBalanceKobo = 1_000_000

    let baseURL: URL
    let merchant: TestUser
    let customer: TestUser
    let recipient: TestUser
    let fixedLink: String
    let openLink: String
    let disabledLink: String

    struct SignedIn {
        let client: KobolinkAPIClient
        let token: SessionToken
        let user: SignedInUser
    }

    func anonymousClient() -> KobolinkAPIClient {
        KobolinkAPIClient(configuration: APIConfiguration(baseURL: baseURL))
    }

    /// A client wired the way the app wires it: the real middleware reading the token from a store.
    func signedInClient(_ user: TestUser) async throws -> SignedIn {
        let store = InMemoryTokenStore()
        let relay = SessionRejectionRelay()
        let client = KobolinkAPIClient(
            configuration: APIConfiguration(baseURL: baseURL),
            middlewares: [AuthMiddleware(baseURL: baseURL, tokenStore: store, relay: relay)])
        let session = try await client.login(email: user.email, password: user.password)
        let token = try #require(session.token)
        try store.saveToken(token)
        return SignedIn(client: client, token: token, user: session.user)
    }

    static func make(baseURL: URL) async throws -> RealWorld {
        let tag = UUID().uuidString.prefix(8).lowercased()
        func user(_ name: String, _ phoneSuffix: Int) -> TestUser {
            TestUser(
                email: "\(name)-\(tag)@x2.example.test",
                // Per-run, never written anywhere.
                password: "Pw" + UUID().uuidString.replacingOccurrences(of: "-", with: ""),
                phone: String(format: "+234803%07d", phoneSuffix),
                displayName: name.capitalized + " Test")
        }
        let suffix = Int.random(in: 1_000_000...9_999_000)
        let merchant = user("merchant", suffix)
        let customer = user("customer", suffix + 1)
        let recipient = user("recipient", suffix + 2)
        let http = RawHTTP(baseURL: baseURL)
        var tokens: [String: String] = [:]
        for (person, role) in [(merchant, "merchant"), (customer, "customer"), (recipient, "customer")] {
            let body = try await http.post(
                "/api/auth/register",
                json: [
                    "email": person.email, "password": person.password, "displayName": person.displayName,
                    "phone": person.phone, "role": role, "client": "mobile",
                ], expect: 201)
            tokens[person.email] = body["token"] as? String
        }
        let merchantToken = try #require(tokens[merchant.email])
        let customerToken = try #require(tokens[customer.email])

        func link(_ fields: [String: Any]) async throws -> String {
            let body = try await http.post("/api/links", json: fields, token: merchantToken, expect: 201)
            return try #require(body["code"] as? String)
        }
        let fixed = try await link(["title": "Ankara fabric, 2 yards", "description": "Delivery in Lagos within 3 days.", "amountKobo": 250_000, "isReusable": true])
        let open = try await link(["title": "Pay \(merchant.displayName)", "isReusable": true])
        let disabled = try await link(["title": "Disabled", "amountKobo": 100_000, "isReusable": true])
        _ = try await http.request("PATCH", "/api/links/\(disabled)/status", json: ["status": "disabled"], token: merchantToken, expect: 200)

        _ = try await http.post(
            "/api/wallet/topup", json: ["amountKobo": openingBalanceKobo], token: customerToken, idempotencyKey: IdempotencyKey.make(), expect: 201)

        return RealWorld(
            baseURL: baseURL, merchant: merchant, customer: customer, recipient: recipient,
            fixedLink: fixed, openLink: open, disabledLink: disabled)
    }
}

/// Plain URLSession + JSON, for the setup calls the app itself never makes.
struct RawHTTP {
    let baseURL: URL

    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    func post(
        _ path: String, json: [String: Any], token: String? = nil, idempotencyKey: String? = nil, expect: Int
    ) async throws -> [String: Any] {
        try await request("POST", path, json: json, token: token, idempotencyKey: idempotencyKey, expect: expect)
    }

    func request(
        _ method: String, _ path: String, json: [String: Any], token: String? = nil, idempotencyKey: String? = nil, expect: Int
    ) async throws -> [String: Any] {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
        request.httpBody = try JSONSerialization.data(withJSONObject: json)
        let (data, response) = try await URLSession(configuration: .ephemeral).data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == expect else {
            // The body is an ApiError (no secrets); a failed setup should say why.
            throw Failure(description: "\(method) \(path): expected \(expect), got \(status): \(String(decoding: data.prefix(300), as: UTF8.self))")
        }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }
}
