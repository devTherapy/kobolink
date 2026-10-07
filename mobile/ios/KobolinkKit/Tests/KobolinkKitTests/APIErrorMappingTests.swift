import Foundation
import Testing

@testable import KobolinkKit

/// `ApiError` bodies and every other way a call can end, mapped to `APIError`.
@Suite("API errors map to typed errors")
struct APIErrorMappingTests {

    @Test("a validation failure carries its code, status and per-field messages")
    func validationFailed() async throws {
        let body = Payloads.apiError(
            "validation_failed",
            "Check the highlighted fields.",
            extra: ",\"fields\":{\"email\":[\"Enter a valid email\"],\"amountKobo\":[\"Too small\",\"Whole kobo only\"]}"
        )
        let error = await failure { try await makeClient(.json(body, status: 400)).publicLink(code: "aBcDeFgH") }
        guard case .server(let server) = error else {
            Issue.record("expected .server, got \(String(describing: error))")
            return
        }
        #expect(server.status == 400)
        #expect(server.code == .validation_failed)
        #expect(server.message == "Check the highlighted fields.")
        #expect(server.fieldErrors["email"] == ["Enter a valid email"])
        #expect(server.fieldErrors["amountKobo"] == ["Too small", "Whole kobo only"])
        #expect(server.moneyMoved == nil)
    }

    @Test("moneyMoved: false is preserved, and absence stays nil rather than defaulting to false")
    func moneyMoved() async {
        let refused = Payloads.apiError("insufficient_funds", "Not enough balance.", extra: ",\"moneyMoved\":false")
        let withFlag = await failure { try await makeClient(.json(refused, status: 422)).publicLink(code: "aBcDeFgH") }
        #expect(withFlag.serverError?.moneyMoved == false)
        #expect(withFlag.serverError?.code == .insufficient_funds)

        let silent = Payloads.apiError("internal", "Something went wrong.")
        let withoutFlag = await failure { try await makeClient(.json(silent, status: 500)).publicLink(code: "aBcDeFgH") }
        #expect(withoutFlag.serverError?.moneyMoved == nil)
    }

    @Test("link_not_payable carries the link state")
    func linkState() async {
        let body = Payloads.apiError(
            "link_not_payable", "This link was already paid.",
            extra: ",\"moneyMoved\":false,\"state\":\"already-paid\""
        )
        let error = await failure { try await makeClient(.json(body, status: 409)).publicLink(code: "aBcDeFgH") }
        #expect(error.serverError?.linkState == .already_hyphen_paid)
        #expect(error.serverError?.status == 409)
    }

    @Test("401 is recognised as unauthenticated")
    func unauthenticated() async {
        let body = Payloads.apiError("unauthenticated", "Sign in to continue.")
        let error = await failure { try await makeClient(.json(body, status: 401)).publicLink(code: "aBcDeFgH") }
        #expect(error.serverError?.isUnauthenticated == true)
    }

    @Test("a 404 not_found for an unknown link is a server answer, not a transport failure")
    func notFound() async {
        let body = Payloads.apiError("not_found", "No such link.")
        let error = await failure { try await makeClient(.json(body, status: 404)).publicLink(code: "aBcDeFgH") }
        #expect(error == .server(.init(status: 404, code: .not_found, message: "No such link.")))
    }

    // MARK: The server answered, but not with an ApiError

    @Test("an HTML 502 from a proxy keeps its status and is not mistaken for an ApiError")
    func proxyHTML() async {
        let transport = StubTransport(reply: .respond(status: 502, contentType: "text/html", body: "<h1>Bad Gateway</h1>"))
        let error = await failure { try await makeClient(transport).publicLink(code: "aBcDeFgH") }
        #expect(error == .unexpectedResponse(status: 502))
    }

    @Test("an empty error body keeps its status")
    func emptyBody() async {
        let transport = StubTransport(reply: .respond(status: 503, contentType: nil, body: ""))
        let error = await failure { try await makeClient(transport).health() }
        #expect(error == .unexpectedResponse(status: 503))
    }

    @Test("an error code newer than this build knows keeps its status")
    func unknownCode() async {
        let body = Payloads.apiError("brand_new_code", "A newer problem.")
        let error = await failure { try await makeClient(.json(body, status: 418)).health() }
        #expect(error == .unexpectedResponse(status: 418))
    }

    @Test("a 200 that is not the contract's shape is undecodable")
    func okButWrongShape() async {
        let error = await failure { try await makeClient(.json("{\"status\":\"degraded\"}")).health() }
        #expect(error == .undecodableResponse)
        let garbage = StubTransport(reply: .respond(status: 200, contentType: "application/json", body: "not json"))
        #expect(await failure { try await makeClient(garbage).health() } == .undecodableResponse)
    }

    // MARK: No answer at all

    @Test(
        "URL errors become .unreachable with their code",
        arguments: [URLError.Code.notConnectedToInternet, .timedOut, .cannotConnectToHost, .secureConnectionFailed]
    )
    func unreachable(code: URLError.Code) async {
        let transport = StubTransport(reply: .fail(URLError(code)))
        let error = await failure { try await makeClient(transport).health() }
        #expect(error == .unreachable(code))
    }

    @Test("a cancelled call is .cancelled, never a failure to display")
    func cancelled() async {
        let viaURL = await failure {
            try await makeClient(StubTransport(reply: .fail(URLError(.cancelled)))).health()
        }
        #expect(viaURL == .cancelled)
        let viaSwift = await failure {
            try await makeClient(StubTransport(reply: .fail(CancellationError()))).health()
        }
        #expect(viaSwift == .cancelled)
        #expect(APIError.cancelled.userMessage == nil)
    }

    // MARK: Success

    @Test("health succeeds on the contract's {status: ok}")
    func healthOK() async {
        let error = await failure { try await makeClient(.json("{\"status\":\"ok\"}")).health() }
        #expect(error == nil)
    }

    // MARK: Requests

    @Test("the request goes to /api/links/{code}/public under the configured base URL")
    func requestShape() async throws {
        for base in ["https://pay.example.test", "https://pay.example.test/", "http://localhost:3001"] {
            let transport = StubTransport.json(Payloads.publicLink)
            _ = try await makeClient(transport, baseURL: base).publicLink(code: "aBcDeFgH")
            let sent = try #require(transport.recorder.all.first)
            #expect(sent.request.path == "/api/links/aBcDeFgH/public")
            #expect(sent.request.method == .get)
            #expect(sent.operationID == "resolvePublicLink")
            #expect(sent.baseURL.host() == URL(string: base)?.host())
            #expect(sent.baseURL.port == URL(string: base)?.port)
        }
    }

    @Test("a code with a slash is percent-encoded, not turned into extra path segments")
    func codeEncoding() async throws {
        let transport = StubTransport.json(Payloads.publicLink)
        _ = try await makeClient(transport).publicLink(code: "a/b?c")
        let path = try #require(transport.recorder.all.first?.request.path)
        #expect(path == "/api/links/a%2Fb%3Fc/public")
    }

    @Test("user messages never leak a status-free blank")
    func userMessages() {
        #expect(APIError.unreachable(.timedOut).userMessage?.isEmpty == false)
        #expect(APIError.unexpectedResponse(status: 502).userMessage?.contains("502") == true)
        #expect(APIError.undecodableResponse.userMessage?.isEmpty == false)
        #expect(APIError.server(.init(status: 400, code: .validation_failed, message: "Fix it.")).userMessage == "Fix it.")
    }
}

extension Optional where Wrapped == APIError {
    fileprivate var serverError: ServerError? {
        if case .server(let error)? = self { return error }
        return nil
    }
}
