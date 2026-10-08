import Foundation
import Testing

@testable import KobolinkKit

@MainActor
private struct Rig {
    let auth = FakeAuth()
    let store: InMemoryTokenStore
    let session: SessionController
    var changes: Captured<[SessionChange]>

    init(token: SessionToken? = nil) {
        store = InMemoryTokenStore(token: token)
        session = SessionController(auth: auth, store: store, installMarker: InMemoryInstallMarker(isSet: true))
        let log = Captured<[SessionChange]>([])
        changes = log
        session.onChange = { log.value.append($0) }
    }
}

@MainActor
@Suite("SessionController tells the rest of the app what changed")
struct SessionChangeTests {
    @Test("a cold start that confirms the stored token reports 'resolved' with the user")
    func resolved() async {
        let rig = Rig(token: Fixture.tokenA)
        await rig.session.resolve()
        #expect(rig.changes.value == [.resolved(Fixture.user)])
    }

    @Test("a cold start with no token reports nothing: no one was signed in, no one signed out")
    func noToken() async {
        let rig = Rig()
        await rig.session.resolve()
        #expect(rig.changes.value.isEmpty)
    }

    @Test("a 401 on the cold start reports the session ENDED (involuntary), and offline reports nothing")
    func coldStartEnd() async {
        let rig = Rig(token: Fixture.tokenA)
        rig.auth.meResult = .failure(.server(ServerError(status: 401, code: .unauthenticated, message: "Sign in.")))
        await rig.session.resolve()
        #expect(rig.changes.value == [.ended])

        let offline = Rig(token: Fixture.tokenA)
        offline.auth.meResult = .failure(.unreachable(.notConnectedToInternet))
        await offline.session.resolve()
        #expect(offline.changes.value.isEmpty)
        offline.auth.meResult = .success(Fixture.user)
        await offline.session.retry()
        #expect(offline.changes.value == [.resolved(Fixture.user)])
    }

    @Test("a sign-in reports 'signedIn'; a chosen sign-out reports 'signedOutByChoice' before the revoke goes out")
    func signInAndOut() async throws {
        let rig = Rig()
        await rig.session.resolve()
        try await rig.session.signIn(email: Fixture.email, password: Fixture.password)
        #expect(rig.changes.value == [.signedIn(Fixture.user)])
        let gate = Gate()
        rig.auth.logoutGate = gate
        let signOut = Task { await rig.session.signOut() }
        #expect(await waitUntil { rig.auth.calls.contains(.logout(Fixture.tokenA)) })
        // The revoke is still in the air, and the checkout has already been told.
        #expect(rig.changes.value == [.signedIn(Fixture.user), .signedOutByChoice])
        gate.open()
        await signOut.value
    }

    @Test("a sign-out whose token cannot be removed is still a chosen sign-out")
    func signOutTokenNotRemoved() async {
        let rig = Rig(token: Fixture.tokenA)
        await rig.session.resolve()
        rig.store.fail(.clear)
        await rig.session.signOut()
        #expect(rig.changes.value == [.resolved(Fixture.user), .signedOutByChoice])
    }

    @Test("a mid-session 401 reports 'ended', and a stale one for an old token reports nothing")
    func midSessionEnd() async {
        let rig = Rig(token: Fixture.tokenA)
        await rig.session.resolve()
        rig.session.tokenRejected(Fixture.tokenB)
        #expect(rig.changes.value == [.resolved(Fixture.user)])
        rig.session.tokenRejected(Fixture.tokenA)
        #expect(rig.changes.value == [.resolved(Fixture.user), .ended])
    }

    @Test("a failed sign-in reports nothing")
    func failedSignIn() async {
        let rig = Rig()
        rig.auth.loginResult = .failure(.server(ServerError(status: 401, code: .unauthenticated, message: "No.")))
        try? await rig.session.signIn(email: Fixture.email, password: "wrong")
        #expect(rig.changes.value.isEmpty)
    }

    @Test("a sign-out the checkout cannot make safe does not happen: still signed in, token kept, nothing revoked, and it says so")
    func signOutRefused() async throws {
        let rig = Rig(token: Fixture.tokenA)
        await rig.session.resolve()
        rig.session.willSignOut = { false }
        await rig.session.signOut()
        #expect(rig.session.state == .signedIn(Fixture.user))
        #expect(try rig.store.readToken() == Fixture.tokenA)
        #expect(rig.session.signOutBlocked)
        #expect(!rig.auth.calls.contains(.logout(Fixture.tokenA)))
        #expect(rig.changes.value == [.resolved(Fixture.user)])
        // Acknowledged, and allowed once it can be made safe.
        rig.session.acknowledgeSignOutBlocked()
        #expect(!rig.session.signOutBlocked)
        rig.session.willSignOut = { true }
        await rig.session.signOut()
        #expect(rig.session.state == .signedOut(.userRequested))
        #expect(!rig.session.signOutBlocked)
        #expect(try rig.store.readToken() == nil)
    }

    @Test("the sign-out is asked about BEFORE the token is touched")
    func askedFirst() async throws {
        let rig = Rig(token: Fixture.tokenA)
        await rig.session.resolve()
        let seen = Captured<[String]>([])
        let store = rig.store
        rig.session.willSignOut = {
            seen.value.append("token still stored: \((try? store.readToken()) != nil)")
            return true
        }
        await rig.session.signOut()
        #expect(seen.value == ["token still stored: true"])
    }

    @Test("who a new attempt belongs to follows the session state")
    func attemptOwner() async throws {
        let rig = Rig(token: Fixture.tokenA)
        #expect(rig.session.attemptOwner == .session(userID: nil))      // resolving
        await rig.session.resolve()
        #expect(rig.session.attemptOwner == .session(userID: Fixture.user.id))
        await rig.session.signOut()
        #expect(rig.session.attemptOwner == .payer)

        let offline = Rig(token: Fixture.tokenA)
        offline.auth.meResult = .failure(.unreachable(.timedOut))
        await offline.session.resolve()
        #expect(offline.session.attemptOwner == .session(userID: nil))   // offline: a token is stored, nobody is confirmed

        let none = Rig()
        await none.session.resolve()
        #expect(none.session.attemptOwner == .payer)
    }

    @Test("a 401 with a body that is not an ApiError is an expired session on cold start, like the signed-in path")
    func unexpected401ColdStart() async throws {
        let rig = Rig(token: Fixture.tokenA)
        rig.auth.meResult = .failure(.unexpectedResponse(status: 401))
        await rig.session.resolve()
        #expect(rig.session.state == .signedOut(.sessionExpired))
        #expect(try rig.store.readToken() == nil)
        #expect(rig.changes.value == [.ended])
    }

    @Test("other unexpected statuses still leave the token alone and go offline")
    func other5xxStillOffline() async throws {
        for status in [403, 404, 500, 502, 503] {
            let rig = Rig(token: Fixture.tokenA)
            rig.auth.meResult = .failure(.unexpectedResponse(status: status))
            await rig.session.resolve()
            if case .offline = rig.session.state {} else { Issue.record("\(status): \(rig.session.state)") }
            #expect(try rig.store.readToken() == Fixture.tokenA)
        }
        let rig = Rig(token: Fixture.tokenA)
        rig.auth.meResult = .failure(.undecodableResponse)
        await rig.session.resolve()
        if case .offline = rig.session.state {} else { Issue.record("undecodable") }
    }

    @Test("isUnauthenticated reads the status of an unparsed 401, and nothing else unparsed")
    func isUnauthenticated() {
        #expect(APIError.unexpectedResponse(status: 401).isUnauthenticated)
        #expect(!APIError.unexpectedResponse(status: 403).isUnauthenticated)
        #expect(!APIError.undecodableResponse.isUnauthenticated)
        #expect(!APIError.unreachable(.timedOut).isUnauthenticated)
        #expect(APIError.server(ServerError(status: 401, code: .unauthenticated, message: "x")).isUnauthenticated)
        #expect(!APIError.cancelled.isUnauthenticated)
    }
}
