import Foundation
import KobolinkAPI
import OpenAPIRuntime
import Testing

@testable import KobolinkKit

/// The generated models, decoded the way the app decodes them (through the
/// generated client over a stub transport), against payload shapes the API
/// really sends. These pin the three ways generated models have failed on
/// Android: a nullable field that could not decode, a 32-bit integer that
/// overflowed on kobo, and a strict decoder that broke on an added field.
@Suite("Generated models decode real payloads")
struct GeneratedModelDecodeTests {

    // MARK: Nullable fields

    @Test("a populated public link keeps every nullable field the generator used to drop")
    func populatedLink() async throws {
        let result = try await makeClient(.json(Payloads.publicLink)).publicLink(code: "aBcDeFgH")
        #expect(result.state == .payable)
        #expect(result.link.description == "Size 12, ships within Lagos in 2 days.")
        #expect(result.link.amountKobo == 1_850_000)
        #expect(result.link.expiresAt == nil)
        #expect(result.link.isReusable)
    }

    @Test("null decodes as nil for description, amountKobo and expiresAt")
    func nullsDecode() async throws {
        let result = try await makeClient(.json(Payloads.publicLinkAllNull)).publicLink(code: "aBcDeFgH")
        #expect(result.link.description == nil)
        #expect(result.link.amountKobo == nil)
        #expect(result.link.expiresAt == nil)
        #expect(result.link.title == "Tip jar")
    }

    @Test("an absent nullable key decodes as nil as well")
    func absentKeysDecode() async throws {
        let body = """
            {"state":"payable","link":{"code":"aBcDeFgH","merchantName":"A","title":"T",\
            "currency":"NGN","isReusable":false}}
            """
        let result = try await makeClient(.json(body)).publicLink(code: "aBcDeFgH")
        #expect(result.link.description == nil)
        #expect(result.link.amountKobo == nil)
        #expect(result.link.expiresAt == nil)
    }

    @Test("a non-null expiresAt decodes to the right instant")
    func expiresAtDecodes() async throws {
        let body = Payloads.publicLink.replacingOccurrences(
            of: "\"expiresAt\":null",
            with: "\"expiresAt\":\"2026-06-20T12:00:00.000Z\""
        )
        let result = try await makeClient(.json(body)).publicLink(code: "aBcDeFgH")
        #expect(result.link.expiresAt == Date(timeIntervalSince1970: 1_781_956_800))
    }

    @Test("a nullable cursor decodes from null on the last page")
    func nullCursor() async throws {
        let body = "{\"items\":[],\"nextCursor\":null}"
        let output = try await generatedClient(.json(body)).listLinks(.init())
        let page = try output.ok.body.json
        #expect(page.items.isEmpty)
        #expect(page.nextCursor == nil)
    }

    // MARK: Money is 64-bit

    @Test("a wallet balance beyond Int32 decodes exactly, in either sign")
    func walletBalanceOverflowsInt32() async throws {
        // 2^53 - 1 is the contracts' bound for a ledger sum; Int32.max kobo is
        // only about 21.4 million naira.
        for balance in [9_007_199_254_740_991, 3_000_000_000, -3_000_000_000, Int(Int32.max) + 1] {
            let body = """
                {"accountId":"acc_9mQ2xV7kLp","currency":"NGN","balanceKobo":\(balance),\
                "asOf":"2026-06-15T12:00:00.000Z"}
                """
            let wallet = try await generatedClient(.json(body)).getWallet(.init()).ok.body.json
            #expect(wallet.balanceKobo == balance)
        }
    }

    // MARK: Dates

    @Test(
        "RFC 3339 dates decode with fractional seconds, without, and with an offset",
        arguments: [
            ("2026-06-15T12:00:00.000Z", 1_781_524_800.0),
            ("2026-06-15T12:00:00Z", 1_781_524_800.0),
            ("2026-06-15T13:00:00+01:00", 1_781_524_800.0),
            ("2026-06-15T12:00:00.250Z", 1_781_524_800.25),
        ]
    )
    func dates(text: String, seconds: Double) async throws {
        let body = """
            {"accountId":"acc_9mQ2xV7kLp","currency":"NGN","balanceKobo":1,"asOf":"\(text)"}
            """
        let wallet = try await generatedClient(.json(body)).getWallet(.init()).ok.body.json
        #expect(abs(wallet.asOf.timeIntervalSince1970 - seconds) < 0.001)
    }

    // MARK: Forward compatibility

    @Test("a field the API adds later is ignored, not fatal")
    func unknownFieldIgnored() async throws {
        let body = Payloads.publicLink.replacingOccurrences(
            of: "\"isReusable\":true",
            with: "\"isReusable\":true,\"brandNewField\":{\"nested\":[1,2,3]}"
        )
        let result = try await makeClient(.json(body)).publicLink(code: "aBcDeFgH")
        #expect(result.link.title == "Ankara Two-Piece Set")
    }

    // MARK: Contract violations still fail

    @Test("a missing required field is an undecodable response, not a half-filled model")
    func missingRequiredField() async {
        let body = "{\"state\":\"payable\",\"link\":{\"code\":\"aBcDeFgH\"}}"
        let error = await failure { try await makeClient(.json(body)).publicLink(code: "aBcDeFgH") }
        #expect(error == .undecodableResponse)
    }

    @Test("a wrong-typed amount is an undecodable response")
    func fractionalKobo() async {
        let body = Payloads.publicLink.replacingOccurrences(of: "1850000", with: "18500.5")
        let error = await failure { try await makeClient(.json(body)).publicLink(code: "aBcDeFgH") }
        #expect(error == .undecodableResponse)
    }

    // MARK: Helpers

    private func generatedClient(_ transport: StubTransport) -> Client {
        Client(
            serverURL: URL(string: "https://pay.example.test")!,
            configuration: .init(dateTranscoder: TolerantISO8601DateTranscoder()),
            transport: transport
        )
    }
}

/// Runs a call and hands back the `APIError` it threw, or nil on success.
/// Any other error escaping the client fails the test: the client's contract
/// is that nothing but `APIError` comes out.
func failure<T>(_ call: () async throws -> T) async -> APIError? {
    do {
        _ = try await call()
        return nil
    } catch let error as APIError {
        return error
    } catch {
        Issue.record("a non-APIError escaped the client: \(error)")
        return nil
    }
}
