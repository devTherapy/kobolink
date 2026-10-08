import Foundation
import KobolinkAPI

/// A payment link as a payer sees it before paying. Mapped once from the generated
/// `PublicLinkResponse` so no screen touches a generated type (their enum cases are named
/// `already_hyphen_paid`, and a closed enum would break on a state this build does not know).
///
/// Money is `Int` kobo, or `nil` for an open-amount link. It is never naira and never a float.
public struct CheckoutLink: Equatable, Hashable, Sendable {
    public let code: LinkCode
    public let merchantName: String
    public let title: String
    /// `nil` when the merchant wrote none (a blank one is dropped).
    public let description: String?
    public let amountKobo: Int?
    public let isReusable: Bool
    public let expiresAt: Date?

    public init(
        code: LinkCode,
        merchantName: String,
        title: String,
        description: String? = nil,
        amountKobo: Int? = nil,
        isReusable: Bool = false,
        expiresAt: Date? = nil
    ) {
        self.code = code
        self.merchantName = merchantName
        self.title = title
        self.description = description
        self.amountKobo = amountKobo
        self.isReusable = isReusable
        self.expiresAt = expiresAt
    }
}

/// Whether a link can take a payment right now, as the server resolved it (`PublicLinkState`).
public enum LinkAvailability: Equatable, Hashable, Sendable {
    case payable
    case disabled
    case expired
    case alreadyPaid
    /// A `link_not_payable` refusal that did not say why. Worded neutrally rather than guessing a
    /// merchant action nobody confirmed.
    case unknown
}

/// The answer to `GET /api/links/{code}/public`.
public struct LinkLookup: Equatable, Sendable {
    public let link: CheckoutLink
    public let availability: LinkAvailability

    public init(link: CheckoutLink, availability: LinkAvailability) {
        self.link = link
        self.availability = availability
    }
}

/// The exact body of `POST /api/checkout/initialize`, and so what one idempotency key is bound to.
/// Equality is how "the same request" is decided: the same key is reused only for an equal request.
public struct InitializeRequest: Equatable, Hashable, Codable, Sendable {
    public let code: LinkCode
    public let amountKobo: Int
    public let payerName: String
    public let payerEmail: String

    public init(code: LinkCode, amountKobo: Int, payerName: String, payerEmail: String) {
        self.code = code
        self.amountKobo = amountKobo
        self.payerName = payerName
        self.payerEmail = payerEmail
    }
}

/// `201` from `initialize`: a pending checkout. The contract returns a `reference` and nothing to
/// redirect to; `verify` is what decides the outcome (feature I4). Nothing has moved yet.
public struct StartedCheckout: Equatable, Sendable {
    public let reference: String
    public let code: LinkCode
    public let amountKobo: Int
    public let createdAt: Date

    public init(reference: String, code: LinkCode, amountKobo: Int, createdAt: Date) {
        self.reference = reference
        self.code = code
        self.amountKobo = amountKobo
        self.createdAt = createdAt
    }

    /// `kbl_` and ten characters of the link-code alphabet (`PaymentReferenceSchema`).
    static func isValidReference(_ reference: String) -> Bool {
        let bytes = Array(reference.utf8)
        guard bytes.count == 14, bytes.starts(with: Array("kbl_".utf8)) else { return false }
        return bytes.dropFirst(4).allSatisfy(LinkCode.alphabet.contains)
    }
}

/// Idempotency keys: one per logical payment attempt, chosen by the client
/// (`IdempotencyKeySchema`: 16 to 128 characters of `A-Z a-z 0-9 _ -`).
public enum IdempotencyKey {
    /// A fresh key. A UUID is 36 characters of hex and hyphens, inside the allowed alphabet.
    public static func make() -> String { UUID().uuidString }

    public static func isValid(_ key: String) -> Bool {
        let bytes = Array(key.utf8)
        return (16...128).contains(bytes.count)
            && bytes.allSatisfy {
                (0x30...0x39).contains($0) || (0x41...0x5A).contains($0) || (0x61...0x7A).contains($0)
                    || $0 == 0x5F || $0 == 0x2D
            }
    }
}

extension Components.Schemas.PublicLinkResponse {
    /// `nil` when the reply names a code or a currency this app cannot honour: treated as an
    /// unreadable reply, never as a payable link.
    var checkoutLookup: LinkLookup? {
        guard let code = LinkCode(link.code), link.code == code.value else { return nil }
        let availability: LinkAvailability
        switch state {
        case .payable: availability = .payable
        case .disabled: availability = .disabled
        case .expired: availability = .expired
        case .already_hyphen_paid: availability = .alreadyPaid
        }
        let note = link.description?.trimmingCharacters(in: .whitespacesAndNewlines)
        return LinkLookup(
            link: CheckoutLink(
                code: code,
                merchantName: link.merchantName,
                title: link.title,
                description: (note?.isEmpty ?? true) ? nil : note,
                amountKobo: link.amountKobo,
                isReusable: link.isReusable,
                expiresAt: link.expiresAt
            ),
            availability: availability
        )
    }
}

extension StartedCheckout {
    init?(_ body: Components.Schemas.InitializeCheckoutResponse) {
        guard StartedCheckout.isValidReference(body.reference), let code = LinkCode(body.code) else { return nil }
        self.init(reference: body.reference, code: code, amountKobo: body.amountKobo, createdAt: body.createdAt)
    }
}

/// The two calls the checkout makes. `KobolinkAPIClient` is the real one; tests supply a script.
///
/// Neither call carries a session token (`AuthMiddleware` sends one only to secured operations): a
/// payer is not the merchant who happens to be signed in on the same phone.
public protocol CheckoutServing: Sendable {
    /// `GET /api/links/{code}/public`.
    func lookupLink(code: LinkCode) async throws(APIError) -> LinkLookup

    /// `POST /api/checkout/initialize` under `idempotencyKey`. The caller holds the key for the whole
    /// life of one attempt: a replay of the same key and body returns the stored answer, never a
    /// second checkout, and the same key with a different body is `idempotency_mismatch`.
    func initializeCheckout(_ request: InitializeRequest, idempotencyKey: String) async throws(APIError) -> StartedCheckout
}
