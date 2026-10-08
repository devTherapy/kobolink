import Foundation

/// The three things a payer types. The server's `validation_failed` field errors are keyed by the
/// wire names (`amountKobo`, `payerName`, `payerEmail`) and mapped to these.
public enum PayerField: String, Equatable, Hashable, Sendable, CaseIterable {
    case amount
    case name
    case email

    init?(wireName: String) {
        switch wireName {
        case "amountKobo": self = .amount
        case "payerName": self = .name
        case "payerEmail": self = .email
        default: return nil
        }
    }
}

/// A payer's validated input, ready to become an `InitializeRequest`. Money is integer kobo.
public struct PayerInput: Equatable, Sendable {
    public let amountKobo: Int
    public let name: String
    public let email: String
}

public enum PayerValidation: Equatable, Sendable {
    case valid(PayerInput)
    case invalid([PayerField: String])

    static let maxNameLength = 80
    static let maxEmailLength = 254

    /// The checkout form's rules, which are the rules the server applies (`InitializeCheckoutRequestSchema`)
    /// and the web form's (`PayForm.validate`): validating here is a courtesy that saves a round trip, and
    /// the server's own `validation_failed` is shown beside the same field if it disagrees.
    ///
    /// - The amount is the link's own when the link has one (what is typed is ignored), otherwise it
    ///   must parse (`Kobo.parseNaira`) and be chargeable (`Kobo.isValidAmountKobo`).
    /// - The name is trimmed and must be 1 to 80 code points (`DisplayNameSchema`; Zod 4 counts code points).
    /// - The email is trimmed and lower-cased, then must match Zod's email pattern and be at most 254
    ///   code points (`EmailSchema`).
    ///
    /// `PayerValidationTests` runs this against `Resources/payer-oracle.json`, contracts' own answers.
    public static func validate(fixedAmountKobo: Int?, amountText: String, name: String, email: String) -> PayerValidation {
        var errors: [PayerField: String] = [:]

        var amountKobo: Int?
        if let fixedAmountKobo {
            amountKobo = fixedAmountKobo
        } else if let parsed = Kobo.parseNaira(amountText), Kobo.isValidAmountKobo(parsed) {
            amountKobo = parsed
        } else {
            errors[.amount] = amountMessage
        }

        let trimmedName = JavaScriptText.trimmed(name)
        if let problem = nameProblem(trimmedName) { errors[.name] = problem }

        let normalisedEmail = normalisedEmail(email)
        if !isValidEmail(normalisedEmail) { errors[.email] = emailMessage }

        guard errors.isEmpty, let amountKobo else { return .invalid(errors) }
        return .valid(PayerInput(amountKobo: amountKobo, name: trimmedName, email: normalisedEmail))
    }

    /// One field on its own, for the check when the person leaves it. `nil` when it is fine (or empty:
    /// nobody is told off for a field they have not reached yet).
    public static func problem(with field: PayerField, text: String) -> String? {
        guard !JavaScriptText.trimmed(text).isEmpty else { return nil }
        switch field {
        case .amount:
            if let parsed = Kobo.parseNaira(text), Kobo.isValidAmountKobo(parsed) { return nil }
            return amountMessage
        case .name:
            return nameProblem(JavaScriptText.trimmed(text))
        case .email:
            return isValidEmail(normalisedEmail(text)) ? nil : emailMessage
        }
    }

    public static var amountMessage: String {
        "Enter an amount between \(Kobo.formatNaira(Kobo.minAmountKobo)) and \(Kobo.formatNaira(Kobo.maxAmountKobo))."
    }
    static let emailMessage = "Enter a valid email address."

    private static func nameProblem(_ trimmed: String) -> String? {
        if trimmed.isEmpty { return "Enter your name." }
        if JavaScriptText.length(trimmed) > maxNameLength { return "Use \(maxNameLength) characters or fewer." }
        return nil
    }

    /// `EmailSchema`'s transform: trimmed, then lower-cased.
    static func normalisedEmail(_ raw: String) -> String {
        JavaScriptText.lowercased(JavaScriptText.trimmed(raw))
    }

    /// `z.email().max(254)` from Zod 4, whose pattern is
    /// `^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`.
    /// Written out by hand: a regular expression engine here would be one more place that disagrees
    /// with JavaScript about `$`, `\d` and Unicode.
    static func isValidEmail(_ email: String) -> Bool {
        guard JavaScriptText.length(email) <= maxEmailLength else { return false }
        let bytes = Array(email.utf8)
        guard bytes.allSatisfy({ $0 < 0x80 }) else { return false }

        let parts = bytes.split(separator: UInt8(ascii: "@"), omittingEmptySubsequences: false)
        guard parts.count == 2 else { return false }
        return isValidLocalPart(Array(parts[0])) && isValidDomain(Array(parts[1]))
    }

    private static func isAlphanumeric(_ byte: UInt8) -> Bool {
        (0x30...0x39).contains(byte) || (0x41...0x5A).contains(byte) || (0x61...0x7A).contains(byte)
    }

    private static func isLocalCharacter(_ byte: UInt8) -> Bool {
        isAlphanumeric(byte) || byte == UInt8(ascii: "_") || byte == UInt8(ascii: "'")
            || byte == UInt8(ascii: "+") || byte == UInt8(ascii: "-")
    }

    private static func isValidLocalPart(_ local: [UInt8]) -> Bool {
        let segments = local.split(separator: UInt8(ascii: "."), omittingEmptySubsequences: false)
        guard let last = segments.last, let lastByte = last.last else { return false }
        // The final segment must end in a character from the class without the apostrophe.
        guard lastByte != UInt8(ascii: "'") else { return false }
        return segments.allSatisfy { !$0.isEmpty && $0.allSatisfy(isLocalCharacter) }
    }

    private static func isValidDomain(_ domain: [UInt8]) -> Bool {
        let labels = domain.split(separator: UInt8(ascii: "."), omittingEmptySubsequences: false)
        guard labels.count >= 2, let tld = labels.last else { return false }
        guard tld.count >= 2, tld.allSatisfy({ (0x41...0x5A).contains($0) || (0x61...0x7A).contains($0) }) else { return false }
        return labels.dropLast().allSatisfy { label in
            guard let first = label.first, isAlphanumeric(first) else { return false }
            return label.allSatisfy { isAlphanumeric($0) || $0 == UInt8(ascii: "-") }
        }
    }
}
