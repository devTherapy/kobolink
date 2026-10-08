import Foundation
import Testing

@testable import KobolinkKit

/// One row of `Resources/link-parser-oracle.json`, written by
/// `Tools/generate-link-parser-cases.mjs` from the real `parseLinkCode` in
/// `packages/contracts` (Node 22, WHATWG URL). Rows are `[input, oracle, expected, reason?]`.
struct OracleRow: Decodable {
    let input: String
    /// What contracts returned.
    let oracle: String?
    /// What the app must return: `oracle`, except where it is deliberately stricter.
    let expected: String?
    /// Why the app is stricter: `scheme`, `host`, `port` or `host-alias`.
    let reason: String?

    init(from decoder: any Decoder) throws {
        var row = try decoder.unkeyedContainer()
        input = try row.decode(String.self)
        oracle = try row.decodeIfPresent(String.self)
        expected = try row.decodeIfPresent(String.self)
        reason = row.isAtEnd ? nil : try row.decode(String.self)
    }

    static func load() throws -> [OracleRow] {
        let url = try #require(Bundle.module.url(forResource: "link-parser-oracle", withExtension: "json"))
        // JSONDecoder, deliberately: JSONSerialization drops a leading U+FEFF / U+00A0 from a string,
        // which would turn rows that contracts rejects into rows that look valid.
        return try JSONDecoder().decode([OracleRow].self, from: Data(contentsOf: url))
    }
}

@Suite("LinkCodeParser against contracts' parseLinkCode")
struct OracleTableTests {
    @Test("the table is large and covers both outcomes and every stricter reason")
    func tableShape() throws {
        let rows = try OracleRow.load()
        #expect(rows.count >= 14_000)
        #expect(rows.filter { $0.oracle != nil }.count >= 1_400)
        #expect(rows.filter { $0.oracle == nil }.count >= 12_000)
        for reason in ["scheme", "host", "port", "host-alias"] {
            #expect(rows.contains { $0.reason == reason }, "no row for \(reason)")
        }
        // Duplicates would make the count a lie.
        #expect(Set(rows.map(\.input)).count == rows.count)
    }

    @Test("the parser returns exactly the expected value for every row")
    func parserMatchesTable() throws {
        let rows = try OracleRow.load()
        var mismatches: [String] = []
        for row in rows {
            let got = LinkCodeParser.parse(row.input)?.value
            if got != row.expected {
                mismatches.append("\(row.input.debugDescription): got \(String(describing: got)), expected \(String(describing: row.expected)) (contracts: \(String(describing: row.oracle)))")
            }
        }
        #expect(mismatches.isEmpty, "\(mismatches.count) of \(rows.count) differ, first: \(mismatches.prefix(10))")
    }

    @Test("the app is never more permissive than contracts")
    func neverLooser() throws {
        let rows = try OracleRow.load()
        let looser = rows.filter { row in
            guard let got = LinkCodeParser.parse(row.input)?.value else { return false }
            return got != row.oracle
        }
        #expect(looser.isEmpty, "\(looser.prefix(10).map(\.input))")
        // And the table itself only ever tightens: expected is the oracle's answer or nil.
        #expect(rows.allSatisfy { $0.expected == $0.oracle || $0.expected == nil })
        #expect(rows.allSatisfy { ($0.expected != $0.oracle) == ($0.reason != nil) })
    }

    @Test("the strictness is confined to scheme, host and port: stricter rows are never a bare path or the custom scheme")
    func strictnessIsDocumented() throws {
        let rows = try OracleRow.load()
        for row in rows where row.reason != nil {
            let lowered = row.input.lowercased()
            #expect(!lowered.hasPrefix("kobolink:"), "\(row.input.debugDescription)")
            #expect(!row.input.hasPrefix("/l/"), "\(row.input.debugDescription)")
        }
    }
}
