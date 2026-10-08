import Foundation

/// What a scanned Kobolink code resolves to: exactly the fields the transfer form needs.
public struct ScannedPayee: Equatable, Sendable {
    /// E.164. This is the recipient: the only identifier the app trusts from a code.
    public let toPhone: String
    /// What the code's creator WROTE. Anyone can make a code with any name on it, so it is shown only labelled as
    /// unverified, beside the number, and dropped the moment the number is edited.
    public let displayName: String
    /// A requested amount, or `nil` when the payer chooses.
    public let amountKobo: Int?

    public init(toPhone: String, displayName: String, amountKobo: Int?) {
        self.toPhone = toPhone
        self.displayName = displayName
        self.amountKobo = amountKobo
    }
}

public enum QrRejection: Equatable, Sendable {
    /// Not text this app can read as a Kobolink payload at all (a website, a Wi-Fi code, noise, a payload too large
    /// to be one).
    case notKobolink
    /// A `v` other than 1: a newer app made it, and guessing at its fields could send money to the wrong place.
    case unsupportedVersion
    /// The right shape with bad contents: a phone number or amount outside what a transfer accepts, an unreadable
    /// name, a key that is missing, repeated or not in the format.
    case invalid

    public var message: String {
        switch self {
        case .notKobolink: "That isn't a Kobolink payment code."
        case .unsupportedVersion: "This code was made by a newer version of Kobolink. Update the app to pay with it."
        case .invalid: "This payment code is damaged or has details Kobolink can't use."
        }
    }
}

public enum QrDecodeResult: Equatable, Sendable {
    case payee(ScannedPayee)
    case rejected(QrRejection)
}

/// Decodes the text of a scanned QR code. THE ONE PLACE that knows the format; the camera only hands it text.
///
/// The format is `QrPayload` from `packages/contracts/src/wallet.ts`, built by `buildQrPayload` in
/// `apps/api/src/wallet/qr-payload.ts`, which returns the object after `QrPayloadSchema.parse`:
/// `{"v":1,"toPhone":"+2348031234567","displayName":"Ada Obi","amountKobo":null}`. contracts defines the object and
/// nothing about how it is serialised into the QR; JSON text is the only reading its schema supports (B8 has no
/// endpoint and no route that prints one yet), so this is the paying side's whole contract with it.
///
/// STRICT, because a wrong guess here sends money. Where the schema would repair or ignore, this refuses:
/// - the text must be one JSON object, at most 2 KiB, that starts with `{`, with exactly the four keys, each once (a
///   repeated key is how two readers see two different recipients in one code);
/// - `v` must be the integer 1 (anything else is "newer app", checked before the rest so a future payload that adds
///   a key is told apart from a damaged one);
/// - `toPhone` must already be E.164 `+234[789][01]XXXXXXXX` in ASCII, not `0803...`, not spaced;
/// - `displayName` is a string whose trim is 1 to 80 code points and which carries no control character, line or
///   paragraph separator, or bidirectional override (those let a short name draw as someone else's);
/// - `amountKobo` is `null` or an integer inside the transfer bounds, never a string, a boolean or a fraction.
///
/// The generated models are not used: `QrPayload` has `v` as a one-value enum and its `amountKobo` nullable, and a
/// few explicit checks read more clearly than the machinery to bend them.
public enum QrPayloadDecoder {
    /// A payload is about 150 bytes; the largest legal one is under a kilobyte even with every character escaped.
    static let maximumBytes = 2_048
    static let supportedVersion = 1
    static let nameMaxLength = 80

    private enum Scalar: Decodable {
        case null
        case bool
        case integer(Int)
        case string(String)
        /// An object, an array, or a number that is not an integer.
        case other

        init(from decoder: any Decoder) throws {
            let container = try decoder.singleValueContainer()
            if container.decodeNil() { self = .null; return }
            if (try? container.decode(Bool.self)) != nil { self = .bool; return }
            if let integer = try? container.decode(Int.self) { self = .integer(integer); return }
            if let string = try? container.decode(String.self) { self = .string(string); return }
            self = .other
        }
    }

    public static func decode(_ text: String) -> QrDecodeResult {
        let bytes = Array(text.utf8)
        guard bytes.count <= maximumBytes else { return .rejected(.notKobolink) }
        guard let object = try? JSONDecoder().decode([String: Scalar].self, from: Data(bytes)) else {
            return .rejected(.notKobolink)
        }
        let structure = scan(bytes)
        guard structure != .malformed else { return .rejected(.notKobolink) }

        // Not ours at all without a version marker; a version we do not know is a more useful message.
        guard let version = object["v"] else { return .rejected(.notKobolink) }
        guard case .integer(supportedVersion) = version else { return .rejected(.unsupportedVersion) }

        guard structure == .ok, Set(object.keys) == ["v", "toPhone", "displayName", "amountKobo"] else {
            return .rejected(.invalid)
        }

        guard case .string(let phone)? = object["toPhone"], NigerianPhone.isE164(phone) else { return .rejected(.invalid) }

        guard case .string(let rawName)? = object["displayName"], let name = cleanName(rawName) else { return .rejected(.invalid) }

        let amount: Int?
        switch object["amountKobo"] {
        case .null?:
            amount = nil
        case .integer(let value)? where Kobo.isValidAmountKobo(value):
            amount = value
        default:
            return .rejected(.invalid)
        }
        return .payee(ScannedPayee(toPhone: phone, displayName: name, amountKobo: amount))
    }

    /// The name as it is shown, or `nil` when it is not one this app will show.
    static func cleanName(_ raw: String) -> String? {
        let name = JavaScriptText.trimmed(raw)
        guard !name.isEmpty, JavaScriptText.length(name) <= nameMaxLength else { return nil }
        for scalar in name.unicodeScalars where isUnsafeInName(scalar) { return nil }
        return name
    }

    private static func isUnsafeInName(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .control, .lineSeparator, .paragraphSeparator:
            return true
        default:
            break
        }
        switch scalar.value {
        // Bidirectional marks, embeddings, overrides and isolates: they reorder what is drawn around them.
        case 0x061C, 0x200E, 0x200F, 0x202A...0x202E, 0x2066...0x2069:
            return true
        default:
            return false
        }
    }

    private enum Structure { case ok, repeatedKey, malformed }

    /// The checks `JSONDecoder` does not make, on text it has already accepted as one JSON object:
    /// - it must START with `{` (a byte-order mark, or anything else, before it is not ours);
    /// - no raw control byte may sit inside a string (JSON requires them escaped; the decoder lets them through);
    /// - a top-level number must be written as JSON writes numbers (`01` is not, and the decoder reads it anyway);
    /// - no key may repeat. `JSONDecoder` keeps one value per key and does not say which, while a browser's
    ///   `JSON.parse` keeps the last, so a code with two `toPhone`s would show two readers two recipients. Each key
    ///   is decoded as a string, so a key written with an escape is the key it spells.
    private static func scan(_ bytes: [UInt8]) -> Structure {
        let quote = UInt8(ascii: "\""), backslash = UInt8(ascii: "\\"), colon = UInt8(ascii: ":")
        func isSpace(_ byte: UInt8) -> Bool { [0x20, 0x09, 0x0A, 0x0D].contains(byte) }
        guard let first = bytes.first(where: { !isSpace($0) }), first == UInt8(ascii: "{") else { return .malformed }

        var depth = 0
        var index = 0
        var seen = Set<String>()
        var repeated = false
        while index < bytes.count {
            switch bytes[index] {
            case UInt8(ascii: "{"), UInt8(ascii: "["):
                depth += 1
                index += 1
            case UInt8(ascii: "}"), UInt8(ascii: "]"):
                depth -= 1
                index += 1
            case quote:
                let start = index
                index += 1
                while index < bytes.count, bytes[index] != quote {
                    if bytes[index] < 0x20 { return .malformed }
                    index += bytes[index] == backslash ? 2 : 1
                }
                let end = min(index, bytes.count - 1)
                index += 1
                guard depth == 1 else { continue }
                var next = index
                while next < bytes.count, isSpace(bytes[next]) { next += 1 }
                guard next < bytes.count, bytes[next] == colon else { continue }
                guard let key = try? JSONDecoder().decode(String.self, from: Data(bytes[start...end])) else { return .malformed }
                if !seen.insert(key).inserted { repeated = true }

                // The value, if it is a number, must be written as JSON writes numbers.
                var valueStart = next + 1
                while valueStart < bytes.count, isSpace(bytes[valueStart]) { valueStart += 1 }
                if valueStart < bytes.count, bytes[valueStart] == UInt8(ascii: "-") || (0x30...0x39).contains(bytes[valueStart]) {
                    var valueEnd = valueStart
                    while valueEnd < bytes.count, !isSpace(bytes[valueEnd]), bytes[valueEnd] != UInt8(ascii: ","),
                        bytes[valueEnd] != UInt8(ascii: "}")
                    {
                        valueEnd += 1
                    }
                    if !isJSONNumber(bytes[valueStart..<valueEnd]) { return .malformed }
                }
            default:
                index += 1
            }
        }
        return repeated ? .repeatedKey : .ok
    }

    /// `-?(0|[1-9][0-9]*)(.[0-9]+)?([eE][+-]?[0-9]+)?`
    private static func isJSONNumber(_ token: ArraySlice<UInt8>) -> Bool {
        var index = token.startIndex
        func digits() -> Int {
            let from = index
            while index < token.endIndex, (0x30...0x39).contains(token[index]) { index += 1 }
            return index - from
        }
        if index < token.endIndex, token[index] == UInt8(ascii: "-") { index += 1 }
        guard index < token.endIndex else { return false }
        if token[index] == UInt8(ascii: "0") {
            index += 1
        } else if digits() == 0 {
            return false
        }
        if index < token.endIndex, token[index] == UInt8(ascii: ".") {
            index += 1
            guard digits() > 0 else { return false }
        }
        if index < token.endIndex, token[index] == UInt8(ascii: "e") || token[index] == UInt8(ascii: "E") {
            index += 1
            if index < token.endIndex, token[index] == UInt8(ascii: "+") || token[index] == UInt8(ascii: "-") { index += 1 }
            guard digits() > 0 else { return false }
        }
        return index == token.endIndex
    }
}
