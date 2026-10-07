import Foundation
import Testing

@testable import KobolinkKit

/// The readable half: named shapes, grouped by what they prove. The exhaustive half is
/// `OracleTableTests`, which runs the same parser against 14k rows produced by contracts.
@Suite("LinkCodeParser: named shapes")
struct LinkCodeParserTests {
    private let code = "aBcDeFgH"

    private func expect(_ input: String, _ expected: String?, sourceLocation: SourceLocation = #_sourceLocation) {
        #expect(LinkCodeParser.parse(input)?.value == expected, "\(input.debugDescription)", sourceLocation: sourceLocation)
    }

    // MARK: shapes a link arrives in

    @Test("the three documented shapes, with and without trailing noise", arguments: [
        "https://pay.folusayo.com/l/aBcDeFgH",
        "https://pay.folusayo.com/l/aBcDeFgH/",
        "https://pay.folusayo.com/l/aBcDeFgH//",
        "https://pay.folusayo.com/l/aBcDeFgH?utm=whatsapp#x",
        "https://pay.folusayo.com/l/aBcDeFgH?",
        "https://pay.folusayo.com/l/aBcDeFgH#",
        "kobolink://l/aBcDeFgH",
        "kobolink://l/aBcDeFgH/",
        "kobolink://l/aBcDeFgH?x=1#y",
        "/l/aBcDeFgH",
        "/l/aBcDeFgH?x=1",
        "/l/aBcDeFgH//",
    ])
    func accepted(input: String) {
        expect(input, code)
    }

    @Test("a space in the query or fragment never throws the link away (Android's first review finding)", arguments: [
        "https://pay.folusayo.com/l/aBcDeFgH?q=a b",
        "https://pay.folusayo.com/l/aBcDeFgH?q=a b#frag ment",
        "https://pay.folusayo.com/l/aBcDeFgH/?q=a b",
        "kobolink://l/aBcDeFgH?q=a b",
        "/l/aBcDeFgH?q=a b",
    ])
    func spaceInQuery(input: String) {
        expect(input, code)
    }

    @Test("scheme and host are case-insensitive; the code is not", arguments: [
        "HTTPS://pay.folusayo.com/l/aBcDeFgH",
        "hTTps://PAY.FOLUSAYO.COM/l/aBcDeFgH",
        "KOBOLINK://l/aBcDeFgH",
        "Kobolink://l/aBcDeFgH",
    ])
    func caseInsensitivity(input: String) {
        expect(input, code)
    }

    @Test("a kobolink host is exactly lowercase l", arguments: ["kobolink://L/aBcDeFgH", "kobolink://%6C/aBcDeFgH", "kobolink://x/l/aBcDeFgH"])
    func customHost(input: String) {
        expect(input, nil)
    }

    // MARK: the code itself

    @Test("the alphabet drops 0 O 1 I l, and the length is exactly 8", arguments: [
        "abcdefg0", "abcdefgO", "abcdefg1", "abcdefgI", "abcdefgl", "aBcDeFg", "aBcDeFgHx", "",
    ])
    func codeShape(candidate: String) {
        expect("https://pay.folusayo.com/l/\(candidate)", nil)
        expect("kobolink://l/\(candidate)", nil)
        expect("/l/\(candidate)", nil)
        #expect(LinkCode(candidate) == nil)
    }

    @Test("every character of the alphabet is accepted, and nothing else")
    func alphabet() {
        let alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
        #expect(alphabet.count == 57)
        for character in alphabet {
            #expect(LinkCode(String(repeating: character, count: 8)) != nil, "\(character)")
        }
        for byte in UInt8(0)...UInt8(127) where !alphabet.utf8.contains(byte) {
            let candidate = String(decoding: [UInt8](repeating: byte, count: 8), as: UTF8.self)
            #expect(LinkCode(candidate) == nil, "\(byte)")
        }
        #expect(LinkCode("aBcDeFg\u{E9}") == nil)
        #expect(LinkCode("aBcDeFg\n") == nil)
        #expect(LinkCode("aBcDeFgH\n") == nil)
    }

    // MARK: encoded characters (Android's second finding)

    @Test("percent-escapes stay escapes: %48 is three characters, not an H", arguments: [
        "https://pay.folusayo.com/l/aBcDeFg%48",
        "https://pay.folusayo.com/l/aBcDeFg%2F",
        "https://pay.folusayo.com/l/aBcDeFg%2f",
        "https://pay.folusayo.com/l/aBcDeFg%23",
        "https://pay.folusayo.com/l/aBcDeFg%3F",
        "https://pay.folusayo.com/l/aBcDeFgH%20",
        "https://pay.folusayo.com/l/%61BcDeFgH",
        "https://pay.folusayo.com/l/aBcDeFgH%2F",
        "https://pay.folusayo.com/%6C/aBcDeFgH",
        "https://pay.folusayo.com/l%2FaBcDeFgH",
        "kobolink://l/aBcDeFg%48",
        "kobolink://l%2FaBcDeFgH",
        "/l/aBcDeFg%48",
        "/l/aBcDeFg%2F",
    ])
    func percentEscapes(input: String) {
        expect(input, nil)
    }

    // MARK: structure (Android's third finding)

    @Test("scheme-less authority, doubled slashes and relative shapes are not links", arguments: [
        "//evil.example/l/aBcDeFgH",
        "//pay.folusayo.com/l/aBcDeFgH",
        "//l/aBcDeFgH",
        "///l/aBcDeFgH",
        "https://pay.folusayo.com//l/aBcDeFgH",
        "https://pay.folusayo.com/l//aBcDeFgH",
        "kobolink://l//aBcDeFgH",
        "kobolink:///l/aBcDeFgH",
        "kobolink:/l/aBcDeFgH",
        "kobolink:///aBcDeFgH",
        "kobolink://l",
        "kobolink://l/",
        "/l//aBcDeFgH",
        "l/aBcDeFgH",
        "./l/aBcDeFgH",
        "../l/aBcDeFgH",
        "",
        "not a url",
        "https://",
        "kobolink://",
        "://",
    ])
    func structure(input: String) {
        expect(input, nil)
    }

    @Test("paths that are not /l/{code}", arguments: [
        "https://pay.folusayo.com/dashboard",
        "https://pay.folusayo.com/.well-known/apple-app-site-association",
        "https://pay.folusayo.com/l/",
        "https://pay.folusayo.com/l",
        "https://pay.folusayo.com",
        "https://pay.folusayo.com/",
        "https://pay.folusayo.com/links/aBcDeFgH",
        "https://pay.folusayo.com/l/aBcDeFgH/extra",
        "https://pay.folusayo.com/L/aBcDeFgH",
        "kobolink://dashboard",
        "kobolink://l/aBcDeFgH/extra",
    ])
    func otherPaths(input: String) {
        expect(input, nil)
    }

    // MARK: ports, user-info, fragments

    @Test("the custom scheme: any port is another host, an empty one is none", arguments: [
        ("kobolink://l:80/aBcDeFgH", nil),
        ("kobolink://l:0/aBcDeFgH", nil),
        ("kobolink://l:99999/aBcDeFgH", nil),
        ("kobolink://l:abc/aBcDeFgH", nil),
        ("kobolink://l:80:90/aBcDeFgH", nil),
        ("kobolink://l:/aBcDeFgH", "aBcDeFgH"),
    ] as [(String, String?)])
    func customPorts(input: String, expected: String?) {
        expect(input, expected)
    }

    @Test("https ports: none or the default 443 only", arguments: [
        ("https://pay.folusayo.com:443/l/aBcDeFgH", "aBcDeFgH"),
        ("https://pay.folusayo.com:0443/l/aBcDeFgH", "aBcDeFgH"),
        ("https://pay.folusayo.com:/l/aBcDeFgH", "aBcDeFgH"),
        ("https://pay.folusayo.com:80/l/aBcDeFgH", nil),
        ("https://pay.folusayo.com:8443/l/aBcDeFgH", nil),
        ("https://pay.folusayo.com:65536/l/aBcDeFgH", nil),
        ("https://pay.folusayo.com:abc/l/aBcDeFgH", nil),
        ("https://pay.folusayo.com:443:443/l/aBcDeFgH", nil),
    ] as [(String, String?)])
    func httpsPorts(input: String, expected: String?) {
        expect(input, expected)
    }

    @Test("user-info is ignored; the host after the last @ is what counts", arguments: [
        ("https://user@pay.folusayo.com/l/aBcDeFgH", "aBcDeFgH"),
        ("https://user:secret@pay.folusayo.com/l/aBcDeFgH", "aBcDeFgH"),
        ("https://pay.folusayo.com@evil.example/l/aBcDeFgH", nil),
        ("https://evil.example@pay.folusayo.com/l/aBcDeFgH", "aBcDeFgH"),
        ("https://evil.example\\@pay.folusayo.com/l/aBcDeFgH", nil),
        ("kobolink://user@l/aBcDeFgH", "aBcDeFgH"),
        ("kobolink://l@x/aBcDeFgH", nil),
    ] as [(String, String?)])
    func userInfo(input: String, expected: String?) {
        expect(input, expected)
    }

    @Test("fragments and queries end the path, even when they contain a path", arguments: [
        ("https://pay.folusayo.com/dashboard?next=/l/aBcDeFgH", nil),
        ("https://pay.folusayo.com/dashboard#/l/aBcDeFgH", nil),
        ("https://pay.folusayo.com/l/aBcDeFgH#/other", "aBcDeFgH"),
        ("https://pay.folusayo.com?/l/aBcDeFgH", nil),
        ("https://pay.folusayo.com#/l/aBcDeFgH", nil),
        ("/l/aBcDeFgH#/other", "aBcDeFgH"),
    ] as [(String, String?)])
    func queryAndFragment(input: String, expected: String?) {
        expect(input, expected)
    }

    // MARK: hosts

    @Test("only pay.folusayo.com, written literally", arguments: [
        "https://evil.example/l/aBcDeFgH",
        "https://pay.folusayo.com.evil.example/l/aBcDeFgH",
        "https://evilpay.folusayo.com/l/aBcDeFgH",
        "https://sub.pay.folusayo.com/l/aBcDeFgH",
        "https://pay.folusayo.com./l/aBcDeFgH",
        "https://evil.example/pay.folusayo.com/l/aBcDeFgH",
        "https://localhost:3000/l/aBcDeFgH",
        "https:///l/aBcDeFgH",
        "https://pay%2Efolusayo.com/l/aBcDeFgH",
        "https://%70ay.folusayo.com/l/aBcDeFgH",
        "https://\u{FF50}\u{FF41}\u{FF59}.folusayo.com/l/aBcDeFgH",
        "https://[::1]/l/aBcDeFgH",
        "https://pay.folusayo.com\u{1}/l/aBcDeFgH",
    ])
    func hosts(input: String) {
        expect(input, nil)
    }

    @Test("other schemes are rejected, even though contracts reads the path for any scheme", arguments: [
        "http://pay.folusayo.com/l/aBcDeFgH",
        "http://localhost:3000/l/aBcDeFgH",
        "ftp://pay.folusayo.com/l/aBcDeFgH",
        "content://pay.folusayo.com/l/aBcDeFgH",
        "javascript:/l/aBcDeFgH",
        "l:/l/aBcDeFgH",
        "kobolink2://l/aBcDeFgH",
        "file:///l/aBcDeFgH",
    ])
    func schemes(input: String) {
        expect(input, nil)
    }

    // MARK: WHATWG quirks contracts inherits

    @Test("backslashes are slashes in an https URL and nowhere else", arguments: [
        ("https://pay.folusayo.com\\l\\aBcDeFgH", "aBcDeFgH"),
        ("https:\\\\pay.folusayo.com\\l/aBcDeFgH", "aBcDeFgH"),
        ("https://pay.folusayo.com/l\\aBcDeFgH", "aBcDeFgH"),
        ("https://pay.folusayo.com/l/aBcDeFgH\\", "aBcDeFgH"),
        ("\\l\\aBcDeFgH", nil),
        ("/l\\aBcDeFgH", nil),
        ("kobolink://l\\aBcDeFgH", nil),
        ("kobolink://l/aBcDeFgH\\", nil),
    ] as [(String, String?)])
    func backslashes(input: String, expected: String?) {
        expect(input, expected)
    }

    @Test("dot segments resolve inside a full URL, and not in a bare path", arguments: [
        ("https://pay.folusayo.com/l/./aBcDeFgH", "aBcDeFgH"),
        ("https://pay.folusayo.com/x/../l/aBcDeFgH", "aBcDeFgH"),
        ("https://pay.folusayo.com/../l/aBcDeFgH", "aBcDeFgH"),
        ("https://pay.folusayo.com/l/aBcDeFgH/.", "aBcDeFgH"),
        ("https://pay.folusayo.com/l/aBcDeFgH/./", "aBcDeFgH"),
        ("https://pay.folusayo.com/l/x/../aBcDeFgH", "aBcDeFgH"),
        ("https://pay.folusayo.com/l/%2e/aBcDeFgH", "aBcDeFgH"),
        ("https://pay.folusayo.com/x/%2E%2e/l/aBcDeFgH", "aBcDeFgH"),
        ("https://pay.folusayo.com/x/.%2E/l/aBcDeFgH", "aBcDeFgH"),
        ("kobolink://l/./aBcDeFgH", "aBcDeFgH"),
        ("kobolink://l/x/../aBcDeFgH", "aBcDeFgH"),
        ("https://pay.folusayo.com/l/aBcDeFgH/..", nil),
        ("https://pay.folusayo.com/l/aBcDeFgH/../", nil),
        ("https://pay.folusayo.com/l/../aBcDeFgH", nil),
        ("https://pay.folusayo.com/l/.../aBcDeFgH", nil),
        ("https://pay.folusayo.com/./l/..//aBcDeFgH", nil),
        ("/l/./aBcDeFgH", nil),
        ("/x/../l/aBcDeFgH", nil),
        ("/l/../l/aBcDeFgH", nil),
    ] as [(String, String?)])
    func dotSegments(input: String, expected: String?) {
        expect(input, expected)
    }

    @Test("tab, CR and LF are deleted and edge whitespace is trimmed before parsing a URL, not a bare path", arguments: [
        (" https://pay.folusayo.com/l/aBcDeFgH", "aBcDeFgH"),
        ("https://pay.folusayo.com/l/aBcDeFgH ", "aBcDeFgH"),
        ("\thttps://pay.folusayo.com/l/aBcDeFgH\n", "aBcDeFgH"),
        ("\u{1}https://pay.folusayo.com/l/aBcDeFgH\u{1F}", "aBcDeFgH"),
        ("https://pay.folusayo.com/l/aBcDeF\tgH", "aBcDeFgH"),
        ("https://pay.folusayo.com/l/aBcDeF\ngH", "aBcDeFgH"),
        ("https://pay.folusayo.com/l/aBcDeF\r\ngH", "aBcDeFgH"),
        ("https://pay.fol\tusayo.com/l/aBcDeFgH", "aBcDeFgH"),
        ("kobolink://l/aBcDeFgH\n", "aBcDeFgH"),
        ("https://pay.folusayo.com/l/aBcDeF gH", nil),
        ("https://pay.folusayo.com/l/aBcDeFgH\u{A0}", nil),
        ("\u{A0}https://pay.folusayo.com/l/aBcDeFgH", nil),
        ("\u{FEFF}https://pay.folusayo.com/l/aBcDeFgH", nil),
        (" /l/aBcDeFgH", nil),
        ("\t/l/aBcDeFgH", nil),
        ("/l/aBcDeFgH ", nil),
        ("/l/aBcDeFgH\n", nil),
        ("/l/aBcDeF\tgH", nil),
        ("/l/ aBcDeFgH", nil),
    ] as [(String, String?)])
    func whitespace(input: String, expected: String?) {
        expect(input, expected)
    }

    @Test("https needs no slashes at all, or any number: WHATWG ignores them", arguments: [
        ("https:pay.folusayo.com/l/aBcDeFgH", "aBcDeFgH"),
        ("https:/pay.folusayo.com/l/aBcDeFgH", "aBcDeFgH"),
        ("https:///pay.folusayo.com/l/aBcDeFgH", "aBcDeFgH"),
        ("https:////pay.folusayo.com/l/aBcDeFgH", "aBcDeFgH"),
        ("https:/l/aBcDeFgH", nil),
    ] as [(String, String?)])
    func ignoredSlashes(input: String, expected: String?) {
        expect(input, expected)
    }

    @Test("kobolink:l/{code}, with no slashes, is what contracts calls a link; kobolink:/l/{code} is not", arguments: [
        ("kobolink:l/aBcDeFgH", "aBcDeFgH"),
        ("kobolink:l/aBcDeFgH//", "aBcDeFgH"),
        ("kobolink:l/aBcDeFgH?x#y", "aBcDeFgH"),
        ("kobolink:l/./aBcDeFgH", nil),
        ("kobolink:l//aBcDeFgH", nil),
        ("kobolink:l/aBcDeFgH%20", nil),
        ("kobolink:l/aBcDeFgH ?x", nil),
        ("kobolink:l", nil),
        ("kobolink:", nil),
        ("kobolink:/l/aBcDeFgH", nil),
        ("kobolink:/l/./aBcDeFgH", nil),
    ] as [(String, String?)])
    func opaquePath(input: String, expected: String?) {
        expect(input, expected)
    }

    // MARK: robustness

    @Test("adversarial input returns nil instead of crashing", arguments: [
        String(repeating: "/", count: 100_000),
        String(repeating: "../", count: 50_000),
        "https://" + String(repeating: "a", count: 100_000),
        "kobolink://" + String(repeating: "@", count: 10_000),
        "https://pay.folusayo.com/" + String(repeating: "./", count: 50_000) + "l/",
        "\u{0}/l/aBcDeFgH",
        "\u{1F600}https://pay.folusayo.com/l/aBcDeFgH",
        "https://pay.folusayo.com/l/aBcDeFg\u{1F600}",
    ])
    func adversarial(input: String) {
        #expect(LinkCodeParser.parse(input) == nil)
    }

    @Test("a long query, and a trailing NUL (trimmed as a C0 control), do not stop a link working")
    func longAndTrimmed() {
        expect("https://pay.folusayo.com/l/aBcDeFgH?" + String(repeating: "q=1&", count: 50_000), code)
        expect("https://pay.folusayo.com/l/aBcDeFgH\u{0}", code)
    }

    @Test("a Foundation URL goes through the same parser")
    func urlOverload() {
        #expect(LinkCodeParser.parse(URL(string: "kobolink://l/aBcDeFgH")!)?.value == code)
        #expect(LinkCodeParser.parse(URL(string: "https://pay.folusayo.com/l/aBcDeFgH?q=a%20b")!)?.value == code)
        #expect(LinkCodeParser.parse(URL(string: "https://pay.folusayo.com/l/aBcDeFgH?q=a b")!)?.value == code)
        #expect(LinkCodeParser.parse(URL(string: "https://pay.folusayo.com/l/aBcDeFg%48")!) == nil)
        #expect(LinkCodeParser.parse(URL(string: "https://evil.example/l/aBcDeFgH")!) == nil)
    }
}
