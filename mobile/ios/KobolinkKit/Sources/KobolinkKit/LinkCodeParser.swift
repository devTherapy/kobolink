import Foundation

/// A payment link's short code: exactly 8 characters from the 57-symbol alphabet
/// `packages/contracts/src/code.ts` generates (no 0, O, 1, l, I). (Its doc comment says 54;
/// the string beside it has 57, and a test counts it.)
///
/// The same rule is the `code` pattern in `apps/api/openapi.json`,
/// `^[2-9A-HJ-NP-Za-km-z]{8}$`. It is held here as a literal rather than
/// generated: the OpenAPI generator emits a plain `String` for the field, so
/// this is the one place Swift knows the shape. `LinkCodeParserTests` pins it
/// from the other side by running contracts' own parser over thousands of
/// inputs.
public struct LinkCode: Hashable, Sendable, Codable, CustomStringConvertible {
    public static let length = 8
    static let alphabet = Set("23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".utf8)

    public let value: String

    /// `nil` unless `candidate` is exactly a link code.
    public init?(_ candidate: String) {
        let bytes = Array(candidate.utf8)
        guard Self.isValid(bytes) else { return nil }
        self.value = candidate
    }

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        guard let code = LinkCode(raw) else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Not a link code")
            )
        }
        self = code
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(value)
    }

    public var description: String { value }

    static func isValid(_ bytes: [UInt8]) -> Bool {
        bytes.count == length && bytes.allSatisfy(alphabet.contains)
    }
}

/// Extracts the link code from anything a deep link can hand the app, and
/// agrees with `parseLinkCode` in `packages/contracts/src/routes.ts` on every
/// shape it accepts or rejects.
///
/// Two forms are links: `https://pay.folusayo.com/l/{code}` (a universal link)
/// and `kobolink://l/{code}` (the custom scheme that needs no entitlement).
/// A bare `/l/{code}` path is accepted too, because contracts accepts it.
/// Everything else returns `nil`.
///
/// ## Why this is a hand-written parser
///
/// contracts reads `new URL(input).pathname` (WHATWG), and `Foundation.URL`,
/// `URLComponents` and `java.net.URI` disagree with WHATWG in exactly the places
/// that matter here: they decode percent-escapes, collapse `//`, read a
/// scheme-less `//host/path` as an authority and throw on a space in the query.
/// Android's parser needed three review rounds to find those. So this one works
/// on the UTF-8 bytes and follows the WHATWG URL Standard for the only parts
/// the contract can observe, and `link-parser-oracle.json` (14k inputs run
/// through the real contracts function under Node) is what proves it.
///
/// The behaviour that surprises, all inherited from contracts and WHATWG:
/// - leading and trailing C0 controls and spaces are trimmed, and tab, CR and
///   LF are deleted anywhere, *before* parsing (so `aBcDeF<TAB>gH` is a code);
///   a bare `/l/...` path is the exception, contracts takes it as written;
/// - for `https`, `\` is a `/`, any number of slashes (or none) follow the
///   scheme, and user-info is ignored;
/// - `.` and `..` segments, in their `%2e` spellings too, are resolved; an
///   empty segment is not, so `//l/x` and `/l//x` are not links;
/// - percent-escapes stay escapes (`%48` is three characters);
/// - `kobolink` is not a special scheme: its host is exactly `l`, in that case,
///   and a port (`kobolink://l:80/x`) changes it. An *empty* port
///   (`kobolink://l:/x`) does not. `kobolink:l/x`, with no slashes, is also a link:
///   contracts joins an empty host and the opaque path into `/l/x`;
/// - any number of trailing slashes after the code are ignored.
///
/// ## Where it is deliberately stricter, never looser
///
/// contracts reads `pathname` for *every* scheme and accepts any host. The app
/// is handed arbitrary URLs, so it additionally requires:
/// - scheme `https` or `kobolink` (not `http`, `ftp`, ...): `scheme`;
/// - host exactly `pay.folusayo.com`, case-insensitive: `host`;
/// - no port, or the default 443: `port`;
/// - the literal name, not a percent-encoded or full-width spelling that only
///   resolves to it after decoding: `host-alias`.
///
/// The tags are the `reason` column of the oracle table.
public enum LinkCodeParser {
    /// `LINK_DOMAIN` in contracts. Hand-kept; a test reads routes.ts and fails if it drifts.
    public static let linkHost = "pay.folusayo.com"
    /// `IOS_URL_SCHEME` in contracts, and the `CFBundleURLSchemes` entry.
    public static let customScheme = "kobolink"
    /// `LINK_PATH_PREFIX` in contracts.
    public static let pathPrefix = "/l/"

    public static func parse(_ input: String) -> LinkCode? {
        guard let code = parseCode(Array(input.utf8)) else { return nil }
        return LinkCode(code)
    }

    public static func parse(_ url: URL) -> LinkCode? {
        parse(url.absoluteString)
    }

    /// Is this an `https` URL on the verified link host (no port, or 443), whatever its path?
    ///
    /// The one question the in-app browser needs answered. It reads the authority with the same
    /// WHATWG rules as `parse`, because the page is rendered by WebKit, which does: Foundation's
    /// `URL.host` can disagree on `https://evil.example\@pay.folusayo.com/`, where WebKit's host is
    /// `evil.example`. Anything else (another host, `http`, a port, no host) is `false`.
    public static func isLinkHostWebURL(_ string: String) -> Bool {
        guard let (scheme, rest) = splitScheme(whatwgPreprocessed(Array(string.utf8))), scheme == "https" else { return false }
        return specialPath(rest) != nil
    }

    public static func isLinkHostWebURL(_ url: URL) -> Bool {
        isLinkHostWebURL(url.absoluteString)
    }

    // MARK: - Implementation (bytes)

    private static let slash = UInt8(ascii: "/")
    private static let backslash = UInt8(ascii: "\\")
    private static let question = UInt8(ascii: "?")
    private static let hash = UInt8(ascii: "#")
    private static let at = UInt8(ascii: "@")
    private static let colon = UInt8(ascii: ":")
    private static let dot = UInt8(ascii: ".")
    private static let percent = UInt8(ascii: "%")

    private static func parseCode(_ raw: [UInt8]) -> String? {
        // contracts: when `new URL` throws, the path is the raw text up to the first ? or #. Only text that
        // starts "/l/" can pass the prefix test, and such text never has a scheme, so `new URL` always throws.
        if raw.starts(with: Array(pathPrefix.utf8)) {
            return code(inPath: cut(raw, atFirstOf: [question, hash]))
        }

        guard let (scheme, rest) = splitScheme(whatwgPreprocessed(raw)) else { return nil }
        switch scheme {
        case "https": return specialPath(rest).flatMap(code(inPath:))
        case customScheme: return customPath(rest).flatMap(code(inPath:))
        default: return nil
        }
    }

    /// WHATWG pre-processing: trim C0 controls and space from both ends, delete tab, LF and CR everywhere.
    private static func whatwgPreprocessed(_ raw: [UInt8]) -> [UInt8] {
        var start = 0
        var end = raw.count
        while start < end, raw[start] <= 0x20 { start += 1 }
        while end > start, raw[end - 1] <= 0x20 { end -= 1 }
        return raw[start..<end].filter { $0 != 0x09 && $0 != 0x0A && $0 != 0x0D }
    }

    /// `scheme ":" rest`, scheme lowercased. WHATWG: an ASCII letter, then letters, digits, `+`, `-`, `.`.
    private static func splitScheme(_ input: [UInt8]) -> (String, ArraySlice<UInt8>)? {
        guard let first = input.first, isAlpha(first) else { return nil }
        var index = 0
        while index < input.count, isAlpha(input[index]) || isDigit(input[index]) || [UInt8(ascii: "+"), UInt8(ascii: "-"), dot].contains(input[index]) {
            index += 1
        }
        guard index < input.count, input[index] == colon else { return nil }
        let scheme = String(decoding: input[0..<index].map(lowercase), as: UTF8.self)
        return (scheme, input[(index + 1)...])
    }

    /// `https`: returns the normalised path, or `nil` when the URL does not parse or is not the link host.
    private static func specialPath(_ rest: ArraySlice<UInt8>) -> [UInt8]? {
        var index = rest.startIndex
        // "special authority ignore slashes": zero or more of / and \ before the authority.
        while index < rest.endIndex, rest[index] == slash || rest[index] == backslash { index += 1 }
        var authorityEnd = index
        while authorityEnd < rest.endIndex, ![slash, backslash, question, hash].contains(rest[authorityEnd]) { authorityEnd += 1 }

        // Everything up to the last "@" is user-info, and does not matter.
        var hostPort = rest[index..<authorityEnd]
        if let lastAt = hostPort.lastIndex(of: at) { hostPort = hostPort[(lastAt + 1)...] }
        guard !hostPort.isEmpty else { return nil }

        // Host then optional port. The host may not contain ":" (a second one is invalid), so split on the first.
        let host: ArraySlice<UInt8>
        var port: ArraySlice<UInt8> = []
        if let separator = hostPort.firstIndex(of: colon) {
            host = hostPort[..<separator]
            port = hostPort[(separator + 1)...]
        } else {
            host = hostPort
        }
        guard host.map(lowercase).elementsEqual(Array(linkHost.utf8)) else { return nil }
        guard acceptsPort(port) else { return nil }

        var path = Array(rest[authorityEnd...])
        if let stop = path.firstIndex(where: { $0 == question || $0 == hash }) { path.removeSubrange(stop...) }
        // A special URL's path state treats "\" as "/".
        path = path.map { $0 == backslash ? slash : $0 }
        return path.isEmpty ? [slash] : normalised(path)
    }

    /// An empty port is no port; 443 is the https default; anything else is another origin. Non-digits fail to parse.
    private static func acceptsPort(_ port: ArraySlice<UInt8>) -> Bool {
        if port.isEmpty { return true }
        guard port.allSatisfy(isDigit) else { return false }
        var value = 0
        for digit in port {
            value = value * 10 + Int(digit - UInt8(ascii: "0"))
            if value > 65535 { return false }
        }
        return value == 443
    }

    /// `kobolink`: contracts rebuilds `/ + url.host + url.pathname`. Returns that string's bytes, or `nil` when
    /// the URL does not parse. The host is only ever `l` here, so a path that contracts would read as
    /// `/l/{code}` is returned as such; anything else returns a path that cannot start `/l/`.
    private static func customPath(_ rest: ArraySlice<UInt8>) -> [UInt8]? {
        if rest.starts(with: [slash, slash]) {
            // Authority form. For a non-special scheme only "/", "?" and "#" end the authority.
            let authorityStart = rest.startIndex + 2
            var authorityEnd = authorityStart
            while authorityEnd < rest.endIndex, ![slash, question, hash].contains(rest[authorityEnd]) { authorityEnd += 1 }

            var hostPort = rest[authorityStart..<authorityEnd]
            if let lastAt = hostPort.lastIndex(of: at) {
                hostPort = hostPort[(lastAt + 1)...]
                if hostPort.isEmpty { return nil }  // credentials with no host fail to parse
            }
            // The host ends at the first ":"; what follows is the port. contracts' url.host is "l" only when the
            // port is empty ("l:80" is a different host, and a non-numeric or out-of-range port fails to parse), so
            // any non-empty port is nil here. Opaque hosts are not lowercased or decoded: "L" and "%6C" are other hosts.
            var host = hostPort
            if let separator = hostPort.firstIndex(of: colon) {
                host = hostPort[..<separator]
                guard hostPort[(separator + 1)...].isEmpty else { return nil }
            }
            guard host.elementsEqual([UInt8(ascii: "l")]) else { return nil }

            var path = Array(rest[authorityEnd...])
            if let stop = path.firstIndex(where: { $0 == question || $0 == hash }) { path.removeSubrange(stop...) }
            // An empty path stays empty for a non-special URL with an authority.
            return path.isEmpty ? [] : [slash, UInt8(ascii: "l")] + normalised(path)
        }
        if rest.first == slash {
            // "kobolink:/..." has no host, so contracts builds "/" + "" + "/..." which starts "//".
            return nil
        }
        // Opaque path ("kobolink:l/x"): no host, no segment processing; contracts builds "/" + pathname.
        var path = Array(rest)
        if let stop = path.firstIndex(where: { $0 == question || $0 == hash }) { path.removeSubrange(stop...) }
        return [slash] + path
    }

    /// WHATWG path state: resolve `.` and `..` segments (and their `%2e` spellings), keep empty segments.
    /// `path` begins with "/".
    private static func normalised(_ path: [UInt8]) -> [UInt8] {
        let segments = path.dropFirst().split(separator: slash, omittingEmptySubsequences: false).map(Array.init)
        var kept: [[UInt8]] = []
        for (index, segment) in segments.enumerated() {
            let isLast = index == segments.count - 1
            if isDoubleDot(segment) {
                if !kept.isEmpty { kept.removeLast() }
                if isLast { kept.append([]) }
            } else if isSingleDot(segment) {
                if isLast { kept.append([]) }
            } else {
                kept.append(segment)
            }
        }
        var result: [UInt8] = []
        for segment in kept {
            result.append(slash)
            result.append(contentsOf: segment)
        }
        return result
    }

    private static func isSingleDot(_ segment: [UInt8]) -> Bool {
        let folded = segment.map(lowercase)
        return folded == [dot] || folded == Array("%2e".utf8)
    }

    private static func isDoubleDot(_ segment: [UInt8]) -> Bool {
        let folded = segment.map(lowercase)
        return [Array("..".utf8), Array(".%2e".utf8), Array("%2e.".utf8), Array("%2e%2e".utf8)].contains(folded)
    }

    /// contracts' last step: the path starts `/l/`, trailing slashes are dropped, what is left is a code.
    private static func code(inPath path: [UInt8]) -> String? {
        let prefix = Array(pathPrefix.utf8)
        guard path.starts(with: prefix) else { return nil }
        var rest = Array(path.dropFirst(prefix.count))
        while rest.last == slash { rest.removeLast() }
        guard LinkCode.isValid(rest) else { return nil }
        return String(decoding: rest, as: UTF8.self)
    }

    private static func cut(_ bytes: [UInt8], atFirstOf stops: [UInt8]) -> [UInt8] {
        guard let stop = bytes.firstIndex(where: stops.contains) else { return bytes }
        return Array(bytes[..<stop])
    }

    private static func isAlpha(_ byte: UInt8) -> Bool { (0x41...0x5A).contains(byte) || (0x61...0x7A).contains(byte) }
    private static func isDigit(_ byte: UInt8) -> Bool { (0x30...0x39).contains(byte) }
    private static func lowercase(_ byte: UInt8) -> UInt8 { (0x41...0x5A).contains(byte) ? byte + 0x20 : byte }
}
