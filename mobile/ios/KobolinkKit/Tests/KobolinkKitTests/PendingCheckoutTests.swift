import Foundation
import Testing

@testable import KobolinkKit

@Suite("A pending checkout as stored")
struct PendingCheckoutCodecTests {
    @Test("it round-trips with every field, including the reference and the owner")
    func roundTrip() throws {
        for owner in [AttemptOwner.payer, .session(userID: nil), .session(userID: "usr_one")] {
            var pending = CK.pending(owner: owner, reference: CK.reference)
            pending.confirmedAmountKobo = 1_850_000
            let data = try pending.encoded()
            #expect(try PendingCheckout.decoded(from: data) == pending)
        }
        let plain = CK.pending()
        #expect(try PendingCheckout.decoded(from: plain.encoded()) == plain)
    }

    @Test("the stored form is versioned JSON with integer kobo and no float anywhere")
    func shape() throws {
        let data = try CK.pending(amountKobo: 1_850_050).encoded()
        let text = String(decoding: data, as: UTF8.self)
        #expect(text.contains("\"version\":1"))
        #expect(text.contains("\"amountKobo\":1850050"))
        #expect(text.contains("\"createdAt\":1790000000"))
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        for (name, value) in json where name.lowercased().contains("kobo") || name == "createdAt" {
            #expect(value is Int, "\(name)")
        }
    }

    @Test("how verify decided it is stored with the attempt and read back, for every outcome")
    func settledRoundTrip() throws {
        let outcomes: [PaymentResult] = [
            .paid, .declined(reason: "Card declined by the simulated gateway."), .declined(reason: nil),
            .linkExpired, .linkDisabled, .linkAlreadyPaid, .checkoutNotFound,
        ]
        for outcome in outcomes {
            let pending = CK.pending(reference: CK.reference, settled: outcome)
            let back = try PendingCheckout.decoded(from: pending.encoded())
            #expect(back == pending, "\(outcome)")
            #expect(back.settled == outcome)
        }
        // An unsettled attempt stores no mark at all.
        let text = String(decoding: try CK.pending(reference: CK.reference).encoded(), as: UTF8.self)
        #expect(!text.contains("settled"))
    }

    @Test("a mark this build cannot read is dropped, not refused: the attempt is simply verified again")
    func unknownMarkIsDropped() throws {
        let base = try CK.pending(reference: CK.reference).encoded()
        var json = try #require(JSONSerialization.jsonObject(with: base) as? [String: Any])
        json["settledKind"] = "refunded_by_a_future_version"
        let future = try JSONSerialization.data(withJSONObject: json)
        let back = try PendingCheckout.decoded(from: future)
        #expect(back.settled == nil)
        #expect(back.reference == CK.reference)
        #expect(back.key == CK.pending().key)

        json["settledKind"] = 7
        let wrongType = try JSONSerialization.data(withJSONObject: json)
        #expect(try PendingCheckout.decoded(from: wrongType).settled == nil)
    }

    @Test("a mark on an attempt with no reference belongs to nothing and is ignored")
    func markWithoutReference() throws {
        var json = try #require(JSONSerialization.jsonObject(with: CK.pending().encoded()) as? [String: Any])
        json["settledKind"] = "paid"
        let back = try PendingCheckout.decoded(from: JSONSerialization.data(withJSONObject: json))
        #expect(back.settled == nil)
        #expect(back.reference == nil)
    }

    @Test("a record this build cannot read is refused, not guessed at", arguments: [
        "{}", "not json", "{\"version\":2}",
        "{\"version\":1,\"key\":\"short\",\"code\":\"aBcDeFgH\",\"amountKobo\":1,\"payerName\":\"n\",\"payerEmail\":\"e\",\"ownerKind\":\"payer\",\"merchantName\":\"m\",\"title\":\"t\",\"createdAt\":1}",
        "{\"version\":1,\"key\":\"00000000-0000-4000-8000-00000000000A\",\"code\":\"bad\",\"amountKobo\":1,\"payerName\":\"n\",\"payerEmail\":\"e\",\"ownerKind\":\"payer\",\"merchantName\":\"m\",\"title\":\"t\",\"createdAt\":1}",
        "{\"version\":1,\"key\":\"00000000-0000-4000-8000-00000000000A\",\"code\":\"aBcDeFgH\",\"amountKobo\":1.5,\"payerName\":\"n\",\"payerEmail\":\"e\",\"ownerKind\":\"payer\",\"merchantName\":\"m\",\"title\":\"t\",\"createdAt\":1}",
        "{\"version\":1,\"key\":\"00000000-0000-4000-8000-00000000000A\",\"code\":\"aBcDeFgH\",\"amountKobo\":1,\"payerName\":\"n\",\"payerEmail\":\"e\",\"ownerKind\":\"admin\",\"merchantName\":\"m\",\"title\":\"t\",\"createdAt\":1}",
    ])
    func refuses(raw: String) {
        #expect(throws: (any Error).self) { try PendingCheckout.decoded(from: Data(raw.utf8)) }
    }
}

@Suite("The owed sign-out cleanup")
struct SignOutObligationTests {
    @Test("it names attempts by link code and key, and an unreadable slot by its code alone")
    func naming() {
        let owed = SignOutObligation(entries: [.init(code: "aBcDeFgH", key: "key-1"), .init(code: "kLmNpQrS", key: nil)])
        #expect(owed.contains(code: "aBcDeFgH", key: "key-1"))
        #expect(owed.contains(code: "kLmNpQrS", key: nil))
        // A LATER attempt on the same link has a key of its own: it is not named.
        #expect(!owed.contains(code: "aBcDeFgH", key: "key-2"))
        #expect(!owed.contains(code: "kLmNpQrS", key: "key-1"))
        #expect(!owed.contains(code: "zzzzzzzz", key: nil))
    }

    @Test("it round-trips through JSON, and holds no time")
    func codable() throws {
        let owed = SignOutObligation(entries: [.init(code: "aBcDeFgH", key: "key-1"), .init(code: "kLmNpQrS", key: nil)])
        let data = try JSONEncoder().encode(owed)
        #expect(try JSONDecoder().decode(SignOutObligation.self, from: data) == owed)
        let text = String(decoding: data, as: UTF8.self).lowercased()
        #expect(!text.contains("cutoff") && !text.contains("date") && !text.contains("time"))
    }
}

@Suite("The in-memory pending store behaves like the Keychain one")
struct InMemoryPendingStoreTests {
    @Test("save, load, replace and remove, one slot per link code")
    func basics() throws {
        let store = InMemoryPendingCheckoutStore()
        #expect(try store.load(CK.codeA) == nil)
        try store.save(CK.pending(CK.codeA))
        try store.save(CK.pending(CK.codeB, key: "00000000-0000-4000-8000-00000000000B"))
        #expect(try store.load(CK.codeA)?.key == "00000000-0000-4000-8000-00000000000A")
        try store.save(CK.pending(CK.codeA, key: "00000000-0000-4000-8000-0000000000FF"))
        #expect(try store.load(CK.codeA)?.key == "00000000-0000-4000-8000-0000000000FF")
        #expect(try store.all().count == 2)
        try store.remove(CK.codeA)
        try store.remove(CK.codeA)
        #expect(try store.load(CK.codeA) == nil)
        #expect(try store.all().count == 1)
    }

    @Test("failures are switchable and are thrown, never swallowed")
    func failures() {
        let store = InMemoryPendingCheckoutStore()
        store.fail(.write)
        #expect(throws: PendingStoreError.self) { try store.save(CK.pending()) }
        store.heal()
        #expect(throws: Never.self) { try store.save(CK.pending()) }
        store.fail(.read, as: .undecodable)
        do throws(PendingStoreError) { _ = try store.load(CK.codeA) } catch { #expect(error.kind == .undecodable) }
    }
}
