import Foundation
import Testing

@testable import KobolinkKit

@Suite("Payer validation mirrors the server's schemas")
struct PayerValidationTests {
    private struct Table: Decodable {
        let email: [Row]
        let name: [Row]

        struct Row: Decodable {
            let input: String
            /// What the schema produced (normalised), or nil when it refused the input.
            let output: String?
            init(from decoder: any Decoder) throws {
                var row = try decoder.unkeyedContainer()
                input = try row.decode(String.self)
                output = try row.decodeIfPresent(String.self)
            }
        }
    }

    private static func table() throws -> Table {
        let url = try #require(Bundle.module.url(forResource: "payer-oracle", withExtension: "json"))
        return try JSONDecoder().decode(Table.self, from: Data(contentsOf: url))
    }

    @Test("an email is accepted exactly when contracts' EmailSchema accepts it, and normalised the same way")
    func emailOracle() throws {
        let rows = try Self.table().email
        #expect(rows.count >= 500 && rows.contains { $0.output == nil } && rows.contains { $0.output != nil })
        var mismatches: [String] = []
        for row in rows {
            let normalised = PayerValidation.normalisedEmail(row.input)
            let accepted = PayerValidation.isValidEmail(normalised)
            if accepted != (row.output != nil) || (accepted && normalised != row.output) {
                mismatches.append("\(row.input.debugDescription): app \(accepted ? normalised : "refused"), contracts \(row.output ?? "refused")")
            }
        }
        #expect(mismatches.isEmpty, "\(mismatches.count) differ, first: \(mismatches.prefix(10))")
    }

    @Test("a name is accepted exactly when contracts' DisplayNameSchema accepts it after trim, and is sent trimmed")
    func nameOracle() throws {
        let rows = try Self.table().name
        var mismatches: [String] = []
        for row in rows {
            let result = PayerValidation.validate(fixedAmountKobo: 1_000_000, amountText: "", name: row.input, email: "a@b.co")
            switch result {
            case .valid(let input):
                if input.name != row.output { mismatches.append("\(row.input.debugDescription): app \(input.name), contracts \(row.output ?? "refused")") }
            case .invalid(let errors):
                if row.output != nil || errors[.name] == nil { mismatches.append("\(row.input.debugDescription): app refused, contracts \(row.output ?? "refused")") }
            }
        }
        #expect(mismatches.isEmpty, "\(mismatches)")
    }

    @Test("the 80 is counted in code points, as Zod 4 counts them: 80 emoji pass, 81 do not")
    func nameLengthInCodePoints() {
        func result(_ name: String) -> PayerValidation {
            PayerValidation.validate(fixedAmountKobo: 1_000_000, amountText: "", name: name, email: "a@b.co")
        }
        if case .valid = result(String(repeating: "😀", count: 80)) {} else { Issue.record("80 emoji") }
        #expect(result(String(repeating: "😀", count: 81)) == .invalid([.name: "Use 80 characters or fewer."]))
        // A letter with a combining accent is two code points; a family emoji is seven.
        if case .valid = result(String(repeating: "e\u{301}", count: 40)) {} else { Issue.record("40 accented") }
        #expect(result(String(repeating: "e\u{301}", count: 41)) == .invalid([.name: "Use 80 characters or fewer."]))
        if case .valid = result(String(repeating: "👨‍👩‍👧‍👦", count: 11)) {} else { Issue.record("11 families") }
        #expect(result(String(repeating: "👨‍👩‍👧‍👦", count: 12)) == .invalid([.name: "Use 80 characters or fewer."]))
    }

    @Test("a fixed link uses its own amount and ignores what was typed")
    func fixedAmountWins() {
        let result = PayerValidation.validate(fixedAmountKobo: 1_850_000, amountText: "banana", name: "N", email: "n@example.test")
        #expect(result == .valid(PayerInput(amountKobo: 1_850_000, name: "N", email: "n@example.test")))
    }

    @Test("an open link needs a chargeable amount, between ₦100 and ₦10,000,000")
    func openAmount() {
        for (text, kobo) in [("100", 10_000), ("₦10,000,000", 1_000_000_000), ("5,000.5", 500_050)] {
            #expect(PayerValidation.validate(fixedAmountKobo: nil, amountText: text, name: "N", email: "n@example.test")
                == .valid(PayerInput(amountKobo: kobo, name: "N", email: "n@example.test")))
        }
        for text in ["", "99.99", "10000000.01", "-500", "0", "abc", "1.234"] {
            #expect(PayerValidation.validate(fixedAmountKobo: nil, amountText: text, name: "N", email: "n@example.test")
                == .invalid([.amount: "Enter an amount between ₦100 and ₦10,000,000."]), "\(text)")
        }
    }

    @Test("every problem is reported at once, beside its own field")
    func allErrors() {
        #expect(PayerValidation.validate(fixedAmountKobo: nil, amountText: "", name: "", email: "")
            == .invalid([
                .amount: "Enter an amount between ₦100 and ₦10,000,000.", .name: "Enter your name.",
                .email: "Enter a valid email address.",
            ]))
    }

    @Test("the simulated-decline address is still a valid email: the gateway, not the form, declines it")
    func declineAddress() {
        #expect(PayerValidation.isValidEmail("fail@example.test"))
    }

    @Test("server field names map to form fields, and unknown ones are ignored")
    func wireNames() {
        #expect(PayerField(wireName: "amountKobo") == .amount)
        #expect(PayerField(wireName: "payerName") == .name)
        #expect(PayerField(wireName: "payerEmail") == .email)
        #expect(PayerField(wireName: "code") == nil)
    }
}
