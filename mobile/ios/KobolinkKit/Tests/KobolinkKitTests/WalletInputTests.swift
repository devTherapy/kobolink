import Foundation
import Testing

@testable import KobolinkKit

@Suite("Nigerian phone numbers, as PhoneSchema reads them")
struct NigerianPhoneTests {
    @Test("the forms a person types all come to E.164", arguments: [
        ("08031234567", "+2348031234567"),
        ("0803 123 4567", "+2348031234567"),
        ("0803-123-4567", "+2348031234567"),
        ("  0803 123 4567  ", "+2348031234567"),
        ("2348031234567", "+2348031234567"),
        ("234 803 123 4567", "+2348031234567"),
        ("+2348031234567", "+2348031234567"),
        ("+234 803 123 4567", "+2348031234567"),
        ("+234-803-123-4567", "+2348031234567"),
        ("09012345678", "+2349012345678"),
        ("07011234567", "+2347011234567"),
        ("08101234567", "+2348101234567"),
        ("\u{00A0}08031234567\u{00A0}", "+2348031234567"),
    ])
    func normalises(_ typed: String, _ wire: String) {
        #expect(NigerianPhone.normalize(typed) == wire)
    }

    @Test("everything else is refused, never repaired", arguments: [
        "", "   ", "0803123456", "080312345678", "+23480312345", "+2348031234567890", "06031234567", "08231234567",
        "+14155550123", "0803 123 456a", "tel:08031234567", "(0803) 123 4567", "++2348031234567",
        "0803.123.4567", "٠٨٠٣١٢٣٤٥٦٧", "08031234567\n08031234568", "+2348031234567x", "2348031234567 ext 1",
    ])
    func refuses(_ typed: String) {
        #expect(NigerianPhone.normalize(typed) == nil, "\(typed)")
    }

    @Test("the wire form is exact: no normalising", arguments: [
        ("+2348031234567", true), ("+2349012345678", true), ("08031234567", false), ("2348031234567", false),
        ("+234 8031234567", false), ("+2348031234567 ", false), ("+2346031234567", false), ("+2348231234567", false),
        ("+٢٣٤٨٠٣١٢٣٤٥٦٧", false), ("", false),
    ])
    func exact(_ text: String, _ expected: Bool) {
        #expect(NigerianPhone.isE164(text) == expected)
    }

    @Test("display and spoken forms")
    func display() {
        #expect(NigerianPhone.display("+2348031234567") == "0803 123 4567")
        #expect(NigerianPhone.display("not a number") == "not a number")
        #expect(NigerianPhone.spoken("+2348031234567") == "0 8 0 3 1 2 3 4 5 6 7")
    }

    @Test("what is displayed normalises back to the same number")
    func roundTrip() {
        for wire in ["+2348031234567", "+2349012345678", "+2347011234567", "+2348101234567"] {
            #expect(NigerianPhone.normalize(NigerianPhone.display(wire)) == wire)
        }
    }
}

@Suite("The send form's validation")
struct SendValidationTests {
    @Test("a plus sign followed by a space is still the number: the schema removes every space")
    func spaceAfterPlus() {
        #expect(NigerianPhone.normalize("+ 2348031234567") == "+2348031234567")
    }

    @Test("a good form becomes the exact instruction: E.164, integer kobo, a trimmed note")
    func valid() {
        let result = SendValidation.validate(phone: "0803 123 4567", amountText: "1,500.50", note: "  Rent for October  ")
        #expect(result == .valid(TransferInstruction(toPhone: "+2348031234567", amountKobo: 150_050, note: "Rent for October")))
    }

    @Test("a blank or whitespace note is no note at all")
    func blankNote() {
        for note in ["", "   ", "\n\t", "\u{00A0}"] {
            guard case .valid(let instruction) = SendValidation.validate(phone: "08031234567", amountText: "100", note: note) else {
                Issue.record("rejected"); continue
            }
            #expect(instruction.note == nil)
        }
    }

    @Test("a note of 140 characters is fine and 141 is not; an emoji is one character")
    func noteLength() {
        let ok = String(repeating: "a", count: 140)
        let long = String(repeating: "a", count: 141)
        let emoji = String(repeating: "🙂", count: 140)
        #expect(SendValidation.validate(phone: "08031234567", amountText: "100", note: ok) != .invalid([.note: SendValidation.noteTooLong]))
        #expect(SendValidation.validate(phone: "08031234567", amountText: "100", note: long) == .invalid([.note: SendValidation.noteTooLong]))
        guard case .valid = SendValidation.validate(phone: "08031234567", amountText: "100", note: emoji) else { Issue.record("emoji"); return }
    }

    @Test("the amount bounds are the transfer's: ₦100 to ₦10,000,000", arguments: [
        ("99.99", SendValidation.amountTooSmall), ("0", SendValidation.amountTooSmall), ("-500", SendValidation.amountTooSmall),
        ("10,000,000.01", SendValidation.amountTooLarge), ("99999999999", SendValidation.amountTooLarge),
        ("", SendValidation.amountBlank), ("   ", SendValidation.amountBlank),
        ("abc", SendValidation.amountUnreadable), ("1.234", SendValidation.amountUnreadable),
        ("₦", SendValidation.amountUnreadable), ("١٥٠٠", SendValidation.amountUnreadable),
    ])
    func amounts(_ text: String, _ message: String) {
        #expect(SendValidation.validate(phone: "08031234567", amountText: text, note: "") == .invalid([.amount: message]), "\(text)")
    }

    @Test("both ends are accepted", arguments: [("100", 10_000), ("10,000,000", 1_000_000_000), ("₦1,500", 150_000)])
    func edges(_ text: String, _ kobo: Int) {
        #expect(SendValidation.validate(phone: "08031234567", amountText: text, note: "") == .valid(WK.instruction(amountKobo: kobo)))
    }

    @Test("every field is checked at once")
    func everyField() {
        let result = SendValidation.validate(phone: "", amountText: "", note: String(repeating: "x", count: 200))
        #expect(result == .invalid([.phone: SendValidation.phoneBlank, .amount: SendValidation.amountBlank, .note: SendValidation.noteTooLong]))
    }

    @Test("leaving a field you never typed in says nothing")
    func quietWhenEmpty() {
        #expect(SendValidation.problem(with: .phone, text: "", required: false) == nil)
        #expect(SendValidation.problem(with: .amount, text: "  ", required: false) == nil)
        #expect(SendValidation.problem(with: .phone, text: "123", required: false) == SendValidation.phoneInvalid)
    }

    @Test("a server field name maps to a form field")
    func wireNames() {
        #expect(SendField(wireName: "toPhone") == .phone)
        #expect(SendField(wireName: "amountKobo") == .amount)
        #expect(SendField(wireName: "note") == .note)
        #expect(SendField(wireName: "cursor") == nil)
    }
}

@Suite("The stored attempt")
struct TransferAttemptCodecTests {
    @Test("it round-trips, and an absent note stays absent (never null) in the stored record too")
    func roundTrip() throws {
        let withNote = WK.attempt(instruction: WK.instruction(note: "Rent"), payeeName: "Ada Obi")
        #expect(try TransferAttempt.decoded(from: withNote.encoded()) == withNote)
        let plain = WK.attempt()
        let data = try plain.encoded()
        #expect(try TransferAttempt.decoded(from: data) == plain)
        let json = String(decoding: data, as: UTF8.self)
        #expect(!json.contains("note"), "\(json)")
        #expect(!json.contains("payeeName"))
        #expect(!json.contains("null"))
    }

    @Test("a record that is not one is refused rather than half used", arguments: [
        #"{"version":2,"key":"11111111-1111-4111-8111-000000000001","userID":"u","toPhone":"+2348031234567","amountKobo":150000,"createdAt":1}"#,
        #"{"version":1,"key":"short","userID":"u","toPhone":"+2348031234567","amountKobo":150000,"createdAt":1}"#,
        #"{"version":1,"key":"11111111-1111-4111-8111-000000000001","userID":"","toPhone":"+2348031234567","amountKobo":150000,"createdAt":1}"#,
        #"{"version":1,"key":"11111111-1111-4111-8111-000000000001","userID":"u","toPhone":"08031234567","amountKobo":150000,"createdAt":1}"#,
        #"{"version":1,"key":"11111111-1111-4111-8111-000000000001","userID":"u","toPhone":"+2348031234567","amountKobo":50,"createdAt":1}"#,
        #"{"version":1,"key":"11111111-1111-4111-8111-000000000001","userID":"u","toPhone":"+2348031234567","amountKobo":150000.5,"createdAt":1}"#,
        #"{"version":1,"key":"11111111-1111-4111-8111-000000000001","userID":"u","toPhone":"+2348031234567","amountKobo":150000,"note":"","createdAt":1}"#,
        #"not json"#,
    ])
    func refused(_ json: String) {
        #expect((try? TransferAttempt.decoded(from: Data(json.utf8))) == nil, "\(json)")
    }

    @Test("the in-memory store keeps one slot per user and lists them")
    func inMemoryStore() throws {
        let store = InMemoryPendingTransferStore()
        try store.save(WK.attempt(user: WK.userOne))
        try store.save(WK.attempt(key: "11111111-1111-4111-8111-000000000002", user: WK.userTwo))
        try store.save(WK.attempt(key: "11111111-1111-4111-8111-000000000003", user: WK.userOne))
        #expect(try store.load(userID: WK.userOne.id)?.key == "11111111-1111-4111-8111-000000000003")
        #expect(try store.load(userID: WK.userTwo.id)?.key == "11111111-1111-4111-8111-000000000002")
        #expect(try store.all().count == 2)
        try store.remove(userID: WK.userOne.id)
        #expect(try store.load(userID: WK.userOne.id) == nil)
        try store.remove(userID: WK.userOne.id)
    }
}
