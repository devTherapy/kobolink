import Foundation
import HTTPTypes
import OpenAPIRuntime

@testable import KobolinkKit

/// A transport that answers from memory, so the tests exercise the real
/// generated request building, response decoding and error mapping without a
/// network.
struct StubTransport: ClientTransport {
    enum Reply: Sendable {
        case respond(status: Int, contentType: String?, body: String)
        case fail(any Error)
    }

    let recorder = RequestRecorder()
    let reply: Reply

    func send(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String
    ) async throws -> (HTTPResponse, HTTPBody?) {
        recorder.record(.init(request: request, baseURL: baseURL, operationID: operationID))
        switch reply {
        case .fail(let error):
            throw error
        case .respond(let status, let contentType, let text):
            var response = HTTPResponse(status: .init(code: status))
            if let contentType { response.headerFields[.contentType] = contentType }
            return (response, HTTPBody(text))
        }
    }
}

final class RequestRecorder: @unchecked Sendable {
    struct Entry: Sendable {
        let request: HTTPRequest
        let baseURL: URL
        let operationID: String
    }

    private let lock = NSLock()
    private var entries: [Entry] = []

    func record(_ entry: Entry) {
        lock.lock()
        defer { lock.unlock() }
        entries.append(entry)
    }

    var all: [Entry] {
        lock.lock()
        defer { lock.unlock() }
        return entries
    }
}

extension StubTransport {
    static func json(_ body: String, status: Int = 200) -> StubTransport {
        StubTransport(reply: .respond(status: status, contentType: "application/json", body: body))
    }
}

func makeClient(
    _ transport: StubTransport,
    baseURL: String = "https://pay.example.test"
) -> KobolinkAPIClient {
    KobolinkAPIClient(
        configuration: APIConfiguration(baseURL: URL(string: baseURL)!),
        transport: transport
    )
}

/// Payload shapes taken from `packages/contracts/src/fixtures.ts`, which is
/// what the API actually sends.
enum Payloads {
    static let publicLink = """
        {"state":"payable","link":{"code":"aBcDeFgH","merchantName":"Adebayo Stores",\
        "title":"Ankara Two-Piece Set","description":"Size 12, ships within Lagos in 2 days.",\
        "amountKobo":1850000,"currency":"NGN","isReusable":true,"expiresAt":null}}
        """

    /// An open-amount, undescribed, never-expiring link: every nullable is null.
    static let publicLinkAllNull = """
        {"state":"payable","link":{"code":"aBcDeFgH","merchantName":"Adebayo Stores",\
        "title":"Tip jar","description":null,"amountKobo":null,"currency":"NGN",\
        "isReusable":true,"expiresAt":null}}
        """

    static func apiError(
        _ code: String,
        _ message: String,
        extra: String = ""
    ) -> String {
        "{\"code\":\"\(code)\",\"message\":\"\(message)\"\(extra)}"
    }
}
