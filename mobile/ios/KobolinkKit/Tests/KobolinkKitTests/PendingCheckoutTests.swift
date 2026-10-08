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

@Suite("The owed cleanup")
struct CleanupObligationTests {
    private let cutoff = Date(timeIntervalSince1970: 1_790_000_000)
    private var before: Date { cutoff.addingTimeInterval(-60) }
    private var after: Date { cutoff.addingTimeInterval(60) }

    @Test("sign-out removes every session attempt made up to the moment of sign-out, and never a payer's")
    func allSession() {
        let owed = CleanupObligation(scope: .allSession, cutoff: cutoff)
        #expect(owed.removes(.session(userID: nil), createdAt: before))
        #expect(owed.removes(.session(userID: "usr_one"), createdAt: cutoff))
        #expect(!owed.removes(.payer, createdAt: before))
        // A LATER session's attempt is not this obligation's to remove.
        #expect(!owed.removes(.session(userID: "usr_two"), createdAt: after))
    }

    @Test("a confirmed user's cleanup removes other CONFIRMED users' attempts, never an unconfirmed one, never their own")
    func foreign() {
        let owed = CleanupObligation(scope: .foreign, userID: "usr_two", cutoff: cutoff)
        #expect(owed.removes(.session(userID: "usr_one"), createdAt: before))
        #expect(!owed.removes(.session(userID: "usr_two"), createdAt: before))
        #expect(!owed.removes(.session(userID: nil), createdAt: before))
        #expect(!owed.removes(.payer, createdAt: before))
        #expect(!owed.removes(.session(userID: "usr_one"), createdAt: after))
    }

    @Test("it round-trips through JSON as whole seconds")
    func codable() throws {
        for owed in [CleanupObligation(scope: .allSession, cutoff: cutoff), CleanupObligation(scope: .foreign, userID: "usr_one", cutoff: cutoff)] {
            #expect(try JSONDecoder().decode(CleanupObligation.self, from: JSONEncoder().encode(owed)) == owed)
        }
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
