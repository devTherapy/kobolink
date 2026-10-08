import Foundation
import KobolinkAPI

/// The wallet endpoints. All three are secured operations (`AuthMiddleware.securedOperations` carries
/// `getWallet`, `listWalletTransactions`, `transferMoney`), so the token rides on them, to the API origin only.
extension KobolinkAPIClient: WalletServing {
    /// How many activity rows one page asks for.
    static let activityPageSize = 20

    /// `GET /api/wallet`.
    public func wallet() async throws(APIError) -> WalletBalance {
        let (output, notes) = try await perform { try await client.getWallet(.init()) }
        switch output {
        case .ok(let response):
            let body: Components.Schemas.Wallet
            do { body = try response.body.json } catch { throw .undecodableResponse }
            guard let balance = WalletBalance(body) else { throw .undecodableResponse }
            return balance
        case .default(let status, let response):
            throw APIError(status: status, error: try? response.body.json, notes: notes)
        }
    }

    /// `GET /api/wallet/transactions`, one page.
    public func activity(cursor: String?) async throws(APIError) -> ActivityPage {
        let (output, notes) = try await perform {
            try await client.listWalletTransactions(.init(query: .init(cursor: cursor, limit: Self.activityPageSize)))
        }
        switch output {
        case .ok(let response):
            let body: Components.Schemas.WalletTransactionListResponse
            do { body = try response.body.json } catch { throw .undecodableResponse }
            guard let page = ActivityPage(body) else { throw .undecodableResponse }
            return page
        case .default(let status, let response):
            throw APIError(status: status, error: try? response.body.json, notes: notes)
        }
    }

    /// `POST /api/wallet/transfer`. Sends exactly one request: nothing here or below retries, and a redirect is
    /// refused (the body is a recipient and an amount, and the header is a bearer token).
    ///
    /// `note` is OMITTED from the body when there is none. Read the result by what each case lets the caller
    /// conclude (`APIError`): a `.server` refusal answers THIS request and proves nothing about an earlier send of
    /// the same key unless it is one the idempotency layer stores (see `TransferVerdict`).
    public func transfer(_ instruction: TransferInstruction, idempotencyKey: String) async throws(APIError) -> TransferReceipt {
        let (output, notes) = try await perform {
            try await client.transferMoney(
                .init(
                    headers: .init(Idempotency_hyphen_Key: idempotencyKey),
                    body: .json(
                        .init(
                            amountKobo: instruction.amountKobo,
                            note: instruction.note,
                            toPhone: instruction.toPhone
                        ))
                ))
        }
        switch output {
        case .created(let response):
            let body: Components.Schemas.TransferResponse
            do { body = try response.body.json } catch { throw .undecodableResponse }
            guard let receipt = TransferReceipt(body) else { throw .undecodableResponse }
            return receipt
        case .default(let status, let response):
            throw APIError(status: status, error: try? response.body.json, notes: notes)
        }
    }
}
