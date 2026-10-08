import Foundation
import Testing

@testable import KobolinkKit

/// `packages/contracts/tests/money.test.ts`, case for case, then contracts' own answers for a larger
/// table (`Resources/money-oracle.json`, written by `Tools/generate-money-cases.mjs`).
@Suite("Kobo mirrors contracts' money.ts")
struct KoboTests {
    // describe('formatNaira')
    @Test("renders whole naira without a decimal part")
    func wholeNaira() {
        #expect(Kobo.formatNaira(1_850_000) == "₦18,500")
        #expect(Kobo.formatNaira(0) == "₦0")
    }

    @Test("shows kobo only when there is a remainder")
    func koboOnlyWhenNeeded() {
        #expect(Kobo.formatNaira(1_850_050) == "₦18,500.50")
        #expect(Kobo.formatNaira(1_850_005) == "₦18,500.05")
        #expect(Kobo.formatNaira(1_850_000, alwaysShowKobo: true) == "₦18,500.00")
    }

    @Test("handles negatives")
    func negatives() {
        #expect(Kobo.formatNaira(-1_850_000) == "-₦18,500")
    }

    @Test("refuses a float rather than silently rounding it: by type, there is no way to pass one")
    func noFloat() throws {
        // contracts throws a TypeError for 1850.5. Swift cannot be asked: `formatNaira` takes `Int`, there is
        // no `Double` overload (MoneyDisciplineTests keeps it so), and a float on the wire is refused by the
        // decoder (CheckoutClientTests.floatAmountIsUndecodable).
        let formatted: (Int, Bool) -> String = { Kobo.formatNaira($0, alwaysShowKobo: $1) }
        #expect(formatted(185_050, false) == "₦1,850.50")
    }

    // describe('parseNaira')
    @Test("parses", arguments: [
        ("18500", 1_850_000), ("18,500", 1_850_000), ("₦18,500", 1_850_000), (" ₦18,500 ", 1_850_000),
        ("18500.5", 1_850_050), ("18500.05", 1_850_005), ("0", 0),
    ])
    func parses(input: String, expected: Int) {
        #expect(Kobo.parseNaira(input) == expected)
    }

    @Test("rejects rather than guessing", arguments: ["", "abc", "18,50 0.123", "1.2.3", "₦", "18500.123", "--5"])
    func rejects(input: String) {
        #expect(Kobo.parseNaira(input) == nil)
    }

    @Test("round-trips through formatNaira")
    func roundTrip() {
        for kobo in [0, 100, 1_850_000, 1_850_050, 999_999_99] {
            #expect(Kobo.parseNaira(Kobo.formatNaira(kobo, alwaysShowKobo: true)) == kobo)
        }
    }

    // describe('isValidAmountKobo')
    @Test("accepts the boundaries")
    func boundaries() {
        #expect(Kobo.isValidAmountKobo(Kobo.minAmountKobo))
        #expect(Kobo.isValidAmountKobo(Kobo.maxAmountKobo))
        #expect(Kobo.minAmountKobo == 10_000)
        #expect(Kobo.maxAmountKobo == 1_000_000_000)
    }

    @Test("rejects outside them")
    func outside() {
        #expect(!Kobo.isValidAmountKobo(Kobo.minAmountKobo - 1))
        #expect(!Kobo.isValidAmountKobo(Kobo.maxAmountKobo + 1))
        #expect(!Kobo.isValidAmountKobo(-Kobo.minAmountKobo))
        #expect(!Kobo.isValidAmountKobo(0))
    }

    // Beyond contracts' tests.
    @Test("the extremes of Int do not trap")
    func extremes() {
        #expect(Kobo.formatNaira(Int.max) == "₦92,233,720,368,547,758.07")
        #expect(Kobo.formatNaira(Int.min) == "-₦92,233,720,368,547,758.08")
        #expect(Kobo.spokenNaira(Int.min).hasPrefix("minus 92,233,720,368,547,758 naira"))
    }

    @Test("spoken form: whole naira, then kobo")
    func spoken() {
        #expect(Kobo.spokenNaira(1_850_000) == "18,500 naira")
        #expect(Kobo.spokenNaira(1_850_050) == "18,500 naira, 50 kobo")
        #expect(Kobo.spokenNaira(5) == "0 naira, 5 kobo")
        #expect(Kobo.spokenNaira(-100) == "minus 1 naira")
    }

    @Test("the amount field text is digits and a point only, and parses back to the same kobo")
    func fieldText() {
        for kobo in [10_000, 1_850_000, 1_850_050, 1_850_005, 999_999_999] {
            let text = Kobo.fieldText(kobo)
            #expect(text.allSatisfy { $0.isASCII && ($0.isNumber || $0 == ".") })
            #expect(Kobo.parseNaira(text) == kobo)
        }
        #expect(Kobo.fieldText(1_850_000) == "18500")
        #expect(Kobo.fieldText(1_850_050) == "18500.50")
    }

    // The oracle.
    private struct Table: Decodable {
        let min: Int
        let max: Int
        let format: [FormatRow]
        let parse: [ParseRow]
        let valid: [ValidRow]

        // Rows are JSON arrays of mixed types, so each decodes by hand.
        struct FormatRow: Decodable {
            let kobo: Int, plain: String, withKobo: String
            init(from decoder: any Decoder) throws {
                var row = try decoder.unkeyedContainer()
                kobo = try row.decode(Int.self)
                plain = try row.decode(String.self)
                withKobo = try row.decode(String.self)
            }
        }
        struct ParseRow: Decodable {
            let input: String
            let result: Int?
            init(from decoder: any Decoder) throws {
                var row = try decoder.unkeyedContainer()
                input = try row.decode(String.self)
                result = try row.decodeIfPresent(Int.self)
            }
        }
        struct ValidRow: Decodable {
            let kobo: Int
            let valid: Bool
            init(from decoder: any Decoder) throws {
                var row = try decoder.unkeyedContainer()
                kobo = try row.decode(Int.self)
                valid = try row.decode(Bool.self)
            }
        }
    }

    private static func data() throws -> Data {
        // Data, then JSONDecoder: JSONSerialization drops a leading U+FEFF or U+00A0 from a string, which would
        // turn rows contracts rejects into rows that look valid.
        try Data(contentsOf: #require(Bundle.module.url(forResource: "money-oracle", withExtension: "json")))
    }

    @Test("formatNaira agrees with contracts on every row, with and without the kobo flag")
    func oracleFormat() throws {
        let rows = try JSONDecoder().decode(Table.self, from: Self.data()).format
        #expect(rows.count >= 100)
        var mismatches: [String] = []
        for row in rows {
            if Kobo.formatNaira(row.kobo) != row.plain { mismatches.append("\(row.kobo): \(Kobo.formatNaira(row.kobo)) vs \(row.plain)") }
            if Kobo.formatNaira(row.kobo, alwaysShowKobo: true) != row.withKobo {
                mismatches.append("\(row.kobo) (kobo): \(Kobo.formatNaira(row.kobo, alwaysShowKobo: true)) vs \(row.withKobo)")
            }
        }
        #expect(mismatches.isEmpty, "\(mismatches.prefix(10))")
    }

    @Test("parseNaira agrees with contracts on every row, including JavaScript's whitespace and ASCII-only digits")
    func oracleParse() throws {
        let table = try JSONDecoder().decode(Table.self, from: Self.data())
        #expect(table.parse.count >= 600)
        #expect(table.parse.contains { $0.result == nil } && table.parse.contains { $0.result != nil })
        var mismatches: [String] = []
        for row in table.parse where Kobo.parseNaira(row.input) != row.result {
            mismatches.append("\(row.input.debugDescription): got \(String(describing: Kobo.parseNaira(row.input))), contracts \(String(describing: row.result))")
        }
        #expect(mismatches.isEmpty, "\(mismatches.count) differ, first: \(mismatches.prefix(10))")
    }

    @Test("isValidAmountKobo and the limits agree with contracts")
    func oracleValid() throws {
        let table = try JSONDecoder().decode(Table.self, from: Self.data())
        #expect(table.min == Kobo.minAmountKobo && table.max == Kobo.maxAmountKobo)
        for row in table.valid {
            #expect(Kobo.isValidAmountKobo(row.kobo) == row.valid, "\(row.kobo)")
        }
    }

    @Test("a no-break space is whitespace and a zero-width space is not, as in JavaScript")
    func javaScriptWhitespace() {
        #expect(Kobo.parseNaira("\u{00A0}18500\u{00A0}") == 1_850_000)
        #expect(Kobo.parseNaira("\u{FEFF}18500") == 1_850_000)
        #expect(Kobo.parseNaira("\u{200B}18500") == nil)
        #expect(Kobo.parseNaira("１８５００") == nil)
        #expect(Kobo.parseNaira("١٢٣") == nil)
    }
}

// MARK: - Money discipline

/// The rule that makes a float rounding bug a change to one file: only `Kobo.swift` divides or multiplies by
/// 100, and nothing in the app computes money with a floating-point type. This reads the sources.
@Suite("Money discipline: no arithmetic on money outside Kobo.swift")
struct MoneyDisciplineTests {
    /// Every Swift file the app itself wrote: the package sources and the app target. Generated code is not here.
    private static func sources() throws -> [(name: String, text: String)] {
        let thisFile = URL(fileURLWithPath: #filePath)
        let kit = thisFile.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let ios = kit.deletingLastPathComponent()
        var files: [(String, String)] = []
        for root in [kit.appendingPathComponent("Sources/KobolinkKit"), ios.appendingPathComponent("Kobolink")] {
            let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)
            while let url = enumerator?.nextObject() as? URL {
                guard url.pathExtension == "swift" else { continue }
                files.append((url.lastPathComponent, try String(contentsOf: url, encoding: .utf8)))
            }
        }
        return files
    }

    /// Code with comments and string literals blanked out, so prose about "÷ 100" does not trip the scan.
    private static func code(_ text: String) -> String {
        var out = ""
        var index = text.startIndex
        var inLineComment = false, inBlockComment = false, inString = false
        while index < text.endIndex {
            let ch = text[index]
            let next = text.index(after: index) < text.endIndex ? text[text.index(after: index)] : Character(" ")
            if inLineComment {
                if ch == "\n" { inLineComment = false; out.append(ch) }
            } else if inBlockComment {
                if ch == "*" && next == "/" { inBlockComment = false; index = text.index(after: index) }
            } else if inString {
                if ch == "\\" { index = text.index(after: index) } else if ch == "\"" { inString = false }
            } else if ch == "/" && next == "/" {
                inLineComment = true
            } else if ch == "/" && next == "*" {
                inBlockComment = true
            } else if ch == "\"" {
                inString = true
            } else {
                out.append(ch)
            }
            index = text.index(after: index)
        }
        return out
    }

    @Test("the scan finds the sources, and Kobo.swift is the only file with the divisor")
    func onlyKoboDivides() throws {
        let files = try Self.sources()
        #expect(files.count >= 25, "found \(files.count) files; the paths in this test are wrong")
        #expect(files.contains { $0.name == "Kobo.swift" })
        let forbidden = try [
            Regex(#"[/*%]\s*100\b"#), Regex(#"\b100\s*[/*%]"#), Regex(#"\bperNaira\b"#), Regex(#"KOBO_PER_NAIRA"#),
        ]
        var offenders: [String] = []
        for file in files where file.name != "Kobo.swift" {
            let code = Self.code(file.text)
            for pattern in forbidden where code.contains(pattern) { offenders.append("\(file.name): \(pattern)") }
        }
        #expect(offenders.isEmpty, "\(offenders)")
        // Kobo.swift does have it, so the scan is not blind.
        let kobo = try #require(files.first { $0.name == "Kobo.swift" })
        #expect(Self.code(kobo.text).contains("perNaira"))
    }

    @Test("no floating-point or decimal type appears in the app's code")
    func noFloatingPoint() throws {
        let forbidden = try [
            Regex(#"\bDouble\b"#), Regex(#"\bFloat\b"#), Regex(#"\bFloat80\b"#), Regex(#"\bCGFloat\b"#),
            Regex(#"\bDecimal\b"#), Regex(#"\bNSDecimalNumber\b"#), Regex(#"\.currency\b"#), Regex(#"\bNumberFormatter\b"#),
        ]
        var offenders: [String] = []
        for file in try Self.sources() {
            let code = Self.code(file.text)
            for pattern in forbidden where code.contains(pattern) { offenders.append("\(file.name): \(pattern)") }
        }
        #expect(offenders.isEmpty, "\(offenders)")
    }

    @Test("the scan itself can fail: it flags a planted division")
    func scanCanFail() throws {
        let planted = Self.code("let naira = kobo / 100\n// a comment about / 100 is ignored\nlet s = \"/ 100\"")
        #expect(planted.contains(try Regex(#"[/*%]\s*100\b"#)))
        #expect(!Self.code("// kobo / 100").contains(try Regex(#"[/*%]\s*100\b"#)))
    }
}
