import Foundation

/// A Nigerian mobile number, read the way `PhoneSchema` in `packages/contracts/src/primitives.ts` reads it.
///
/// The wire form is always E.164, `+234XXXXXXXXXX`. The form accepts what a person types (`0803 123 4567`,
/// `234 803 123 4567`, `+234-803-123-4567`) and `normalize` brings it to the wire form with the schema's own
/// steps: JavaScript's `trim`, drop every whitespace character and hyphen, then one of three prefixes, then
/// the format check `^\+234[789][01]\d{8}$`. Anything else is `nil`, never repaired.
///
/// The server normalises too, so a drift here costs a refusal, not a misdirected payment; the form still
/// owes the person an answer before the request leaves.
public enum NigerianPhone {
    /// E.164 for what the person typed, or `nil` when it is not a Nigerian mobile number.
    public static func normalize(_ raw: String) -> String? {
        // `.trim()` (the schema's `z.string().trim()`), then `raw.replace(/[\s-]/g, '')`.
        var scalars = Array(JavaScriptText.trimmed(raw).unicodeScalars)
        scalars.removeAll { JavaScriptText.isWhitespace($0) || $0 == "-" }
        let digits = String(String.UnicodeScalarView(scalars))

        let candidate: String
        if isPlusPrefixed(scalars) {
            candidate = digits
        } else if scalars.count == 13, hasPrefix(scalars, "234"), allDigits(scalars) {
            candidate = "+" + digits
        } else if scalars.count == 11, scalars.first == "0", allDigits(scalars) {
            candidate = "+234" + String(digits.dropFirst())
        } else {
            candidate = digits
        }
        return isE164(candidate) ? candidate : nil
    }

    /// Exactly the wire form, with nothing normalised: `^\+234[789][01]\d{8}$`, ASCII digits only.
    public static func isE164(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        guard bytes.count == 14, bytes.starts(with: Array("+234".utf8)) else { return false }
        let national = bytes.dropFirst(4)
        guard let first = national.first, [0x37, 0x38, 0x39].contains(first) else { return false }
        guard let second = national.dropFirst().first, [0x30, 0x31].contains(second) else { return false }
        return national.dropFirst(2).allSatisfy { (0x30...0x39).contains($0) }
    }

    /// `+2348031234567` as people write it, `0803 123 4567`. Anything that is not E.164 comes back unchanged.
    public static func display(_ e164: String) -> String {
        guard isE164(e164) else { return e164 }
        let digits = String(e164.dropFirst(4))
        let first = String(digits.prefix(3))
        let second = String(digits.dropFirst(3).prefix(3))
        let third = String(digits.dropFirst(6))
        return "0\(first) \(second) \(third)"
    }

    /// The number as VoiceOver should say it: digit by digit in groups, so it is not read as a quantity.
    public static func spoken(_ e164: String) -> String {
        display(e164).filter { $0 != " " }.map(String.init).joined(separator: " ")
    }

    private static func isPlusPrefixed(_ scalars: [Unicode.Scalar]) -> Bool {
        scalars.count == 14 && hasPrefix(scalars, "+234") && allDigits(Array(scalars.dropFirst()))
    }

    private static func hasPrefix(_ scalars: [Unicode.Scalar], _ prefix: String) -> Bool {
        let wanted = Array(prefix.unicodeScalars)
        return scalars.count >= wanted.count && Array(scalars.prefix(wanted.count)) == wanted
    }

    private static func allDigits(_ scalars: [Unicode.Scalar]) -> Bool {
        scalars.allSatisfy { (0x30...0x39).contains($0.value) }
    }
}
