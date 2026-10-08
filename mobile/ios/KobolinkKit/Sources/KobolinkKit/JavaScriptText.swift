import Foundation

/// JavaScript's own definitions of whitespace and length, for the places where this app must give
/// the same answer as `packages/contracts` (a Zod schema or `parseNaira` running in Node).
///
/// Swift's `Character.isWhitespace`, `trimmingCharacters(in: .whitespaces)` and `String.count`
/// each disagree with JavaScript on some inputs (a no-break space, U+FEFF, an emoji's length), and a
/// disagreement here is a request the server refuses after the payer was told it was fine.
enum JavaScriptText {
    /// ECMAScript `WhiteSpace` and `LineTerminator`: what `String.prototype.trim` strips and `\s` matches.
    static func isWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        case 0x2000...0x200A:
            return true
        default:
            return false
        }
    }

    /// `input.trim()`.
    static func trimmed(_ input: String) -> String {
        var scalars = Substring(input).unicodeScalars[...]
        while let first = scalars.first, isWhitespace(first) { scalars.removeFirst() }
        while let last = scalars.last, isWhitespace(last) { scalars.removeLast() }
        return String(String.UnicodeScalarView(scalars))
    }

    /// How long Zod 4 says `input` is for `.min()` and `.max()`: Unicode code points, so an emoji is one and
    /// a letter with a combining accent is two. (Zod 4.6 measures UTF-16 code units first and counts code
    /// points only when the limit would be exceeded; for a limit that is the same answer as counting code
    /// points. JavaScript's own `.length` would say two for an emoji.) Grapheme clusters are not used: the
    /// family emoji is seven.
    static func length(_ input: String) -> Int { input.unicodeScalars.count }

    /// `input.toLowerCase()`.
    static func lowercased(_ input: String) -> String { input.lowercased() }
}
