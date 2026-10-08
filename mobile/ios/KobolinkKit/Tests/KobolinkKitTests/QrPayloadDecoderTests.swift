import Foundation
import Testing

@testable import KobolinkKit

// A scanned code is attacker-controlled text. The decoder is strict because a wrong guess sends money, and it is
// the one place to change if the format ever does. Every number and name below is invented.

private func payload(
    v: String = "1", phone: String = "\"+2348031234567\"", name: String = "\"Ada Obi\"", amount: String = "null"
) -> String {
    "{\"v\":\(v),\"toPhone\":\(phone),\"displayName\":\(name),\"amountKobo\":\(amount)}"
}

@Suite("QR payload: what the B8 encoder emits")
struct QrPayloadAcceptedTests {
    @Test("the encoder's output for a payee with no requested amount")
    func goldenOpenAmount() {
        // `JSON.stringify(buildQrPayload({phone: '+2348031234567', displayName: 'Ada Obi'}, null))`
        let text = #"{"v":1,"toPhone":"+2348031234567","displayName":"Ada Obi","amountKobo":null}"#
        #expect(QrPayloadDecoder.decode(text) == .payee(ScannedPayee(toPhone: "+2348031234567", displayName: "Ada Obi", amountKobo: nil)))
    }

    @Test("the encoder's output for a payee who asked for an amount")
    func goldenRequestedAmount() {
        let text = #"{"v":1,"toPhone":"+2349012345678","displayName":"Chidi's Store","amountKobo":250000}"#
        #expect(QrPayloadDecoder.decode(text) == .payee(ScannedPayee(toPhone: "+2349012345678", displayName: "Chidi's Store", amountKobo: 250_000)))
    }

    @Test("the transfer bounds are inclusive", arguments: [Kobo.minAmountKobo, Kobo.maxAmountKobo])
    func bounds(_ kobo: Int) {
        guard case .payee(let payee) = QrPayloadDecoder.decode(payload(amount: "\(kobo)")) else { Issue.record("rejected"); return }
        #expect(payee.amountKobo == kobo)
    }

    @Test("whitespace around the JSON, key order, and a name's own edges do not matter")
    func tolerated() {
        let reordered = #" { "amountKobo" : null , "displayName" : "  Ada Obi  " , "toPhone" : "+2348031234567" , "v" : 1 } "#
        #expect(QrPayloadDecoder.decode(reordered) == .payee(ScannedPayee(toPhone: "+2348031234567", displayName: "Ada Obi", amountKobo: nil)))
    }

    @Test("names in other scripts, with emoji, and exactly 80 characters")
    func names() {
        for name in ["Ngozi Okafor-Eze", "Ọlá Adéṣínà", "Шарлотта", "王小明", "Ada 🙂 Obi", String(repeating: "a", count: 80)] {
            let json = String(data: try! JSONEncoder().encode(name), encoding: .utf8)!
            guard case .payee(let payee) = QrPayloadDecoder.decode(payload(name: json)) else { Issue.record("rejected \(name)"); continue }
            #expect(payee.displayName == name)
        }
    }

    @Test("a requested amount of 150000.0 is the integer 150000, as JSON.parse and Zod read it")
    func integralNumber() {
        guard case .payee(let payee) = QrPayloadDecoder.decode(payload(amount: "150000.0")) else { Issue.record("rejected"); return }
        #expect(payee.amountKobo == 150_000)
    }
}

@Suite("QR payload: what it refuses")
struct QrPayloadRefusedTests {
    static let notKobolink: [(String, String)] = [
        ("empty", ""),
        ("whitespace", "   "),
        ("a web link", "https://pay.folusayo.com/l/aBcDeFgH"),
        ("a Kobolink link", "kobolink://l/aBcDeFgH"),
        ("a tel: URI", "tel:+2348031234567"),
        ("a Wi-Fi code", "WIFI:S:cafe;T:WPA;P:password;;"),
        ("a bare phone number", "+2348031234567"),
        ("an array", "[1]"),
        ("a string", "\"v\""),
        ("a number", "1"),
        ("null", "null"),
        ("truncated JSON", #"{"v":1,"toPhone":"+2348031234567","displayName":"Ada"#),
        ("trailing garbage", payload() + "x"),
        ("two objects", payload() + payload()),
        ("a BOM", "\u{FEFF}" + payload()),
        ("a missing version", #"{"toPhone":"+2348031234567","displayName":"Ada Obi","amountKobo":null}"#),
        ("an object that is not ours", #"{"name":"x"}"#),
        ("a number with a leading zero", payload(v: "01")),
        ("larger than any payload", payload(name: "\"" + String(repeating: "a", count: 3_000) + "\"")),
        ("NUL in the text", payload(name: "\"Ada\u{0}Obi\"")),
    ]

    @Test("text that is not a Kobolink payload at all", arguments: notKobolink)
    func notOurs(_ name: String, _ text: String) {
        #expect(QrPayloadDecoder.decode(text) == .rejected(.notKobolink), "\(name)")
    }

    static let unsupportedVersion: [(String, String)] = [
        ("version 2", payload(v: "2")),
        ("version 0", payload(v: "0")),
        ("a negative version", payload(v: "-1")),
        ("version as a string", payload(v: "\"1\"")),
        ("version as a boolean", payload(v: "true")),
        ("version as null", payload(v: "null")),
        ("version as a fraction", payload(v: "1.5")),
        ("version as an array", payload(v: "[1]")),
        ("a newer payload that added a key", #"{"v":2,"toPhone":"+2348031234567","displayName":"Ada","amountKobo":null,"currency":"USD"}"#),
    ]

    @Test("a version this app does not know is told apart from a damaged code", arguments: unsupportedVersion)
    func version(_ name: String, _ text: String) {
        #expect(QrPayloadDecoder.decode(text) == .rejected(.unsupportedVersion), "\(name)")
    }

    static let invalid: [(String, String)] = [
        // The phone: already E.164, in ASCII, nothing normalised.
        ("a national number", payload(phone: "\"08031234567\"")),
        ("a number without the plus", payload(phone: "\"2348031234567\"")),
        ("a spaced number", payload(phone: "\"+234 803 123 4567\"")),
        ("hyphens", payload(phone: "\"+234-803-123-4567\"")),
        ("a trailing space", payload(phone: "\"+2348031234567 \"")),
        ("a trailing newline", payload(phone: "\"+2348031234567\\n\"")),
        ("too short", payload(phone: "\"+234803123456\"")),
        ("too long", payload(phone: "\"+23480312345678\"")),
        ("not a mobile prefix", payload(phone: "\"+2346031234567\"")),
        ("not a mobile second digit", payload(phone: "\"+2348231234567\"")),
        ("another country", payload(phone: "\"+14155550123\"")),
        ("Arabic-Indic digits", payload(phone: "\"+٢٣٤٨٠٣١٢٣٤٥٦٧\"")),
        ("full-width digits", payload(phone: "\"+２３４８０３１２３４５６７\"")),
        ("a number", payload(phone: "2348031234567")),
        ("null", payload(phone: "null")),
        ("an array of numbers", payload(phone: "[\"+2348031234567\"]")),
        ("an empty string", payload(phone: "\"\"")),
        // The name.
        ("a blank name", payload(name: "\"\"")),
        ("a whitespace name", payload(name: "\"   \"")),
        ("a no-break-space name", payload(name: "\"\\u00a0\\u00a0\"")),
        ("a name of 81 characters", payload(name: "\"" + String(repeating: "a", count: 81) + "\"")),
        ("a name with a newline", payload(name: "\"Ada\\nPay now\"")),
        ("a name with a tab", payload(name: "\"Ada\\tObi\"")),
        ("a name with a control character", payload(name: "\"Ada\\u0007Obi\"")),
        ("a name with a right-to-left override", payload(name: "\"Ada \\u202eibO\"")),
        ("a name with a right-to-left isolate", payload(name: "\"Ada \\u2067Obi\"")),
        ("a name with a left-to-right mark", payload(name: "\"Ada\\u200eObi\"")),
        ("a name with a line separator", payload(name: "\"Ada\\u2028Obi\"")),
        ("a name that is a number", payload(name: "123")),
        ("a name that is null", payload(name: "null")),
        ("a name that is an object", payload(name: "{\"a\":1}")),
        // The amount.
        ("an amount below the minimum", payload(amount: "\(Kobo.minAmountKobo - 1)")),
        ("an amount above the maximum", payload(amount: "\(Kobo.maxAmountKobo + 1)")),
        ("zero", payload(amount: "0")),
        ("a negative amount", payload(amount: "-150000")),
        ("negative zero", payload(amount: "-0")),
        ("a fractional amount", payload(amount: "150000.5")),
        ("an amount as a string", payload(amount: "\"150000\"")),
        ("an amount as a boolean", payload(amount: "true")),
        ("an amount as an array", payload(amount: "[150000]")),
        ("an amount as an object", payload(amount: "{\"a\":1}")),
        ("an amount past Int", payload(amount: "99999999999999999999999")),
        ("an enormous exponent", payload(amount: "1e400")),
        // The shape.
        ("an unknown extra key", #"{"v":1,"toPhone":"+2348031234567","displayName":"Ada","amountKobo":null,"note":"hi"}"#),
        ("a missing phone", #"{"v":1,"displayName":"Ada","amountKobo":null}"#),
        ("a missing name", #"{"v":1,"toPhone":"+2348031234567","amountKobo":null}"#),
        ("a missing amount (the encoder always writes null)", #"{"v":1,"toPhone":"+2348031234567","displayName":"Ada"}"#),
        ("a repeated phone: two readers would see two recipients",
            #"{"v":1,"toPhone":"+2348031234567","toPhone":"+2349012345678","displayName":"Ada","amountKobo":null}"#),
        ("a repeated name", #"{"v":1,"toPhone":"+2348031234567","displayName":"Ada","displayName":"Eve","amountKobo":null}"#),
        ("a repeated key written with an escape",
            #"{"v":1,"toPhone":"+2348031234567","\u0074oPhone":"+2349012345678","displayName":"Ada","amountKobo":null}"#),
        ("a repeated amount", #"{"v":1,"toPhone":"+2348031234567","displayName":"Ada","amountKobo":null,"amountKobo":150000}"#),
    ]

    @Test("right shape, bad contents: never repaired, never partly used", arguments: invalid)
    func damaged(_ name: String, _ text: String) {
        #expect(QrPayloadDecoder.decode(text) == .rejected(.invalid), "\(name)")
    }

    @Test("every rejection has words, and they differ")
    func messages() {
        let messages = [QrRejection.notKobolink, .unsupportedVersion, .invalid].map(\.message)
        #expect(Set(messages).count == 3)
        #expect(messages.allSatisfy { !$0.isEmpty })
    }

    @Test("a hostile name that passes is never trusted to be the recipient: the decoder returns the number as the identity")
    func numberIsIdentity() {
        guard case .payee(let payee) = QrPayloadDecoder.decode(payload(name: "\"Chidi Okeke (verified)\"")) else { Issue.record("rejected"); return }
        #expect(payee.toPhone == "+2348031234567")
        #expect(payee.displayName == "Chidi Okeke (verified)")
        // Nothing in the model marks a name as verified, and the copy always labels it.
        #expect(WalletCopy.qrNameLabel.contains("not verified"))
    }
}
