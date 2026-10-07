import Foundation
import Testing

@testable import KobolinkKit

@MainActor
private struct Rig {
    let auth = FakeAuth()
    let store: InMemoryTokenStore
    let marker: InMemoryInstallMarker
    let session: SessionController

    /// `marker` defaults to "already launched once": an ordinary relaunch, not a fresh install.
    init(token: SessionToken? = nil, installed: Bool = true) {
        store = InMemoryTokenStore(token: token)
        marker = InMemoryInstallMarker(isSet: installed)
        session = SessionController(auth: auth, store: store, installMarker: marker)
    }

    func resolve() async -> SessionState {
        await session.resolve()
        return session.state
    }
}

@MainActor
@Suite("Session controller: cold start")
struct SessionColdStartTests {
    @Test("no stored token resolves straight to signed out, without calling the API")
    func noToken() async {
        let rig = Rig()
        #expect(await rig.resolve() == .signedOut(.noSession))
        #expect(rig.auth.calls.isEmpty)
    }

    @Test("a stored token the server accepts resolves to signed in as that user")
    func validToken() async throws {
        let rig = Rig(token: Fixture.tokenA)
        #expect(await rig.resolve() == .signedIn(Fixture.user))
        #expect(rig.auth.calls == [.currentUser])
        #expect(try rig.store.readToken() == Fixture.tokenA)
    }

    @Test("the state is resolving until /me answers")
    func resolvingWhileWaiting() async {
        let rig = Rig(token: Fixture.tokenA)
        let gate = Gate()
        rig.auth.meGate = gate
        let task = Task { await rig.session.resolve() }
        #expect(await waitUntil { rig.auth.calls == [.currentUser] })
        #expect(rig.session.state == .resolving)
        gate.open()
        await task.value
        #expect(rig.session.state == .signedIn(Fixture.user))
    }

    @Test("no network on cold start keeps the token and goes offline, not signed out")
    func offline() async throws {
        let rig = Rig(token: Fixture.tokenA)
        rig.auth.meResult = .failure(.unreachable(.notConnectedToInternet))
        guard case .offline(let message) = await rig.resolve() else {
            Issue.record("expected offline, got \(rig.session.state)")
            return
        }
        #expect(message.contains("can't reach"))
        #expect(message.contains("haven't been signed out"))
        #expect(try rig.store.readToken() == Fixture.tokenA)
    }

    @Test("a 5xx or an unreadable reply on cold start keeps the token and goes offline", arguments: [
        APIError.unexpectedResponse(status: 502),
        .undecodableResponse,
        .server(ServerError(status: 500, code: ._internal, message: "Something went wrong.")),
    ])
    func serverTrouble(error: APIError) async throws {
        let rig = Rig(token: Fixture.tokenA)
        rig.auth.meResult = .failure(error)
        guard case .offline = await rig.resolve() else {
            Issue.record("expected offline, got \(rig.session.state)")
            return
        }
        #expect(try rig.store.readToken() == Fixture.tokenA)
    }

    @Test("a 403 is not a dead token: it keeps the token")
    func forbiddenKeepsToken() async throws {
        let rig = Rig(token: Fixture.tokenA)
        rig.auth.meResult = .failure(.server(ServerError(status: 403, code: .forbidden, message: "No.")))
        guard case .offline = await rig.resolve() else {
            Issue.record("expected offline")
            return
        }
        #expect(try rig.store.readToken() == Fixture.tokenA)
    }

    @Test("a 401 on cold start clears the token and says the session ended")
    func expiredOnColdStart() async throws {
        let rig = Rig(token: Fixture.tokenA)
        rig.auth.meResult = .failure(.server(ServerError(status: 401, code: .unauthenticated, message: "Sign in.")))
        #expect(await rig.resolve() == .signedOut(.sessionExpired))
        #expect(try rig.store.readToken() == nil)
        #expect(SignedOutReason.sessionExpired.notice != nil)
    }

    @Test("a 401 whose local clear fails still signs out instead of getting stuck")
    func expiredButClearFails() async {
        let rig = Rig(token: Fixture.tokenA)
        rig.auth.meResult = .failure(.server(ServerError(status: 401, code: .unauthenticated, message: "Sign in.")))
        rig.store.fail(.clear)
        #expect(await rig.resolve() == .signedOut(.sessionExpired))
    }

    @Test("a second resolve (the root view's task running again) does not hit the network again")
    func resolveIsOneShot() async {
        let rig = Rig(token: Fixture.tokenA)
        await rig.session.resolve()
        await rig.session.resolve()
        #expect(rig.auth.calls == [.currentUser])
    }

    @Test("retry from offline checks again and signs in once the network is back")
    func retryFromOffline() async {
        let rig = Rig(token: Fixture.tokenA)
        rig.auth.meResult = .failure(.unreachable(.timedOut))
        _ = await rig.resolve()
        rig.auth.meResult = .success(Fixture.user)
        await rig.session.retry()
        #expect(rig.session.state == .signedIn(Fixture.user))
        #expect(rig.auth.calls == [.currentUser, .currentUser])
    }

    @Test("retry does nothing outside offline and storageUnavailable")
    func retryOnlyWhenStuck() async {
        let rig = Rig()
        _ = await rig.resolve()
        await rig.session.retry()
        #expect(rig.session.state == .signedOut(.noSession))
        #expect(rig.auth.calls.isEmpty)
    }
}

@MainActor
@Suite("Session controller: secure storage")
struct SessionStorageTests {
    @Test("an unreadable Keychain is an explicit error state, not signed out, and /me is never called")
    func unreadable() async throws {
        let rig = Rig(token: Fixture.tokenA)
        rig.store.fail(.read)
        #expect(await rig.resolve() == .storageUnavailable)
        #expect(rig.auth.calls.isEmpty)
        rig.store.heal()
        #expect(try rig.store.readToken() == Fixture.tokenA, "the token must not have been touched")
    }

    @Test("retry after the Keychain becomes readable signs in with the token that was there all along")
    func retryAfterUnlock() async {
        let rig = Rig(token: Fixture.tokenA)
        rig.store.fail(.read)
        _ = await rig.resolve()
        rig.store.heal()
        await rig.session.retry()
        #expect(rig.session.state == .signedIn(Fixture.user))
    }

    @Test("while the Keychain stays unreadable, retry stays in the error state")
    func retryStillUnreadable() async {
        let rig = Rig(token: Fixture.tokenA)
        rig.store.fail(.read)
        _ = await rig.resolve()
        await rig.session.retry()
        #expect(rig.session.state == .storageUnavailable)
    }

    @Test("something in the slot that is not a token is cleared and treated as no session")
    func corrupt() async throws {
        let rig = Rig(token: Fixture.tokenA)
        rig.store.fail(.read, as: .corrupt)
        #expect(await rig.resolve() == .signedOut(.sessionExpired))
        rig.store.heal()
        #expect(try rig.store.readToken() == nil)
    }

    // MARK: A fresh install must not trust a leftover token

    @Test("the first launch of an install removes a token the Keychain kept from a previous install")
    func freshInstallPurges() async throws {
        let rig = Rig(token: Fixture.tokenA, installed: false)
        #expect(await rig.resolve() == .signedOut(.noSession))
        #expect(rig.auth.calls.isEmpty, "a leftover token is never sent to the server")
        #expect(try rig.store.readToken() == nil)
        #expect(rig.marker.isSet)
    }

    @Test("the next launch keeps a token saved after that first launch")
    func relaunchKeepsToken() async throws {
        let rig = Rig(token: Fixture.tokenA, installed: false)
        _ = await rig.resolve()
        try rig.store.saveToken(Fixture.tokenB)
        let relaunch = SessionController(auth: rig.auth, store: rig.store, installMarker: rig.marker)
        await relaunch.resolve()
        #expect(relaunch.state == .signedIn(Fixture.user))
        #expect(try rig.store.readToken() == Fixture.tokenB)
    }

    @Test("a purge that fails is reported and retried, never skipped")
    func purgeFailure() async throws {
        let rig = Rig(token: Fixture.tokenA, installed: false)
        rig.store.fail(.clear)
        #expect(await rig.resolve() == .storageUnavailable)
        #expect(!rig.marker.isSet, "the marker is set only after the purge succeeded")
        #expect(rig.auth.calls.isEmpty)
        rig.store.heal()
        await rig.session.retry()
        #expect(rig.session.state == .signedOut(.noSession))
        #expect(try rig.store.readToken() == nil)
        #expect(rig.marker.isSet)
    }

    @Test("a relaunch (marker set) does not purge")
    func markerSetNoPurge() async throws {
        let rig = Rig(token: Fixture.tokenA, installed: true)
        rig.store.fail(.clear)  // would break a purge; a relaunch never tries
        #expect(await rig.resolve() == .signedIn(Fixture.user))
    }
}

@MainActor
@Suite("Session controller: sign in")
struct SessionSignInTests {
    @Test("sign-in saves the token to the store, then signs in")
    func success() async throws {
        let rig = Rig()
        _ = await rig.resolve()
        try await rig.session.signIn(email: Fixture.email, password: Fixture.password)
        #expect(rig.session.state == .signedIn(Fixture.user))
        #expect(try rig.store.readToken() == Fixture.tokenA)
        #expect(rig.auth.calls.contains(.login(email: Fixture.email)))
    }

    @Test("a refused sign-in writes no token and leaves the state alone", arguments: [
        APIError.server(ServerError(status: 401, code: .unauthenticated, message: "Incorrect email or password.")),
        .unreachable(.notConnectedToInternet),
        .server(ServerError(status: 429, code: .rate_limited, message: "Too many.", retryAfterSeconds: 840)),
    ])
    func refused(error: APIError) async throws {
        let rig = Rig()
        _ = await rig.resolve()
        rig.auth.loginResult = .failure(error)
        await #expect(throws: SignInFailure.api(error)) {
            try await rig.session.signIn(email: Fixture.email, password: Fixture.password)
        }
        #expect(try rig.store.readToken() == nil)
        #expect(rig.session.state == .signedOut(.noSession))
    }

    @Test("a 401 on LOGIN is a wrong password, not an expired session")
    func loginUnauthorisedIsNotExpiry() async {
        let rig = Rig()
        _ = await rig.resolve()
        rig.auth.loginResult = .failure(.server(ServerError(status: 401, code: .unauthenticated, message: "No.")))
        _ = try? await rig.session.signIn(email: Fixture.email, password: "wrong")
        #expect(rig.session.state == .signedOut(.noSession))
        #expect(rig.session.state != .signedOut(.sessionExpired))
    }

    @Test("when the Keychain refuses the token the person is NOT signed in, and the server session is revoked")
    func storageRefuses() async throws {
        let rig = Rig()
        _ = await rig.resolve()
        rig.store.fail(.save)
        await #expect(throws: SignInFailure.storage) {
            try await rig.session.signIn(email: Fixture.email, password: Fixture.password)
        }
        #expect(rig.session.state == .signedOut(.noSession))
        #expect(rig.auth.calls.contains(.logout(Fixture.tokenA)), "a session nobody holds must not stay live")
        rig.store.heal()
        #expect(try rig.store.readToken() == nil)
    }

    @Test("a 200 with no token is a failed sign-in, not a signed-in user with nothing to keep")
    func missingToken() async throws {
        let rig = Rig()
        _ = await rig.resolve()
        rig.auth.loginResult = .success(AuthSession(user: Fixture.user, token: nil))
        await #expect(throws: SignInFailure.missingToken) {
            try await rig.session.signIn(email: Fixture.email, password: Fixture.password)
        }
        #expect(rig.session.state == .signedOut(.noSession))
        #expect(try rig.store.readToken() == nil)
    }

    @Test("a second sign-in while one is running is refused, and only one request goes out")
    func doubleTap() async throws {
        let rig = Rig()
        _ = await rig.resolve()
        let gate = Gate()
        rig.auth.loginGate = gate
        let first = Task { try await rig.session.signIn(email: Fixture.email, password: Fixture.password) }
        #expect(await waitUntil { rig.auth.calls.contains(.login(email: Fixture.email)) })
        await #expect(throws: SignInFailure.busy) {
            try await rig.session.signIn(email: Fixture.email, password: Fixture.password)
        }
        gate.open()
        try await first.value
        #expect(rig.auth.calls.filter { $0 == .login(email: Fixture.email) }.count == 1)
    }

    @Test("cancelling the caller cannot land between 'server accepted' and 'token saved'")
    func cancellationDoesNotSplitSignIn() async throws {
        let rig = Rig()
        _ = await rig.resolve()
        let gate = Gate()
        rig.auth.loginGate = gate
        let caller = Task { try await rig.session.signIn(email: Fixture.email, password: Fixture.password) }
        #expect(await waitUntil { !rig.auth.calls.isEmpty })
        caller.cancel()
        gate.open()
        _ = try? await caller.value
        #expect(rig.session.state == .signedIn(Fixture.user))
        #expect(try rig.store.readToken() == Fixture.tokenA)
    }

    @Test("signing in replaces an older token and moves to the new user")
    func userChange() async throws {
        let rig = Rig(token: Fixture.tokenA)
        _ = await rig.resolve()
        rig.auth.loginResult = .success(AuthSession(user: Fixture.otherUser, token: Fixture.tokenB))
        try await rig.session.signIn(email: "other@example.test", password: Fixture.password)
        #expect(rig.session.state == .signedIn(Fixture.otherUser))
        #expect(try rig.store.readToken() == Fixture.tokenB)
    }
}

@MainActor
@Suite("Session controller: sign out and expiry")
struct SessionSignOutTests {
    private func signedIn(_ rig: Rig) async {
        _ = await rig.resolve()
        #expect(rig.session.state == .signedIn(Fixture.user))
    }

    @Test("sign-out removes the token and revokes that token on the server")
    func explicitSignOut() async throws {
        let rig = Rig(token: Fixture.tokenA)
        await signedIn(rig)
        await rig.session.signOut()
        #expect(rig.session.state == .signedOut(.userRequested))
        #expect(try rig.store.readToken() == nil)
        #expect(rig.auth.calls.last == .logout(Fixture.tokenA))
        #expect(SignedOutReason.userRequested.notice == nil)
    }

    @Test("the device is signed out BEFORE the network is touched, so being offline cannot keep it signed in")
    func localFirst() async throws {
        let rig = Rig(token: Fixture.tokenA)
        await signedIn(rig)
        let gate = Gate()
        rig.auth.logoutGate = gate
        let task = Task { await rig.session.signOut() }
        #expect(await waitUntil { rig.auth.calls.last == .logout(Fixture.tokenA) })
        #expect(rig.session.state == .signedOut(.userRequested), "the request is still in flight")
        #expect(try rig.store.readToken() == nil)
        gate.open()
        await task.value
    }

    @Test("sign-out with the server unreachable still signs out")
    func signOutOffline() async throws {
        let rig = Rig(token: Fixture.tokenA)
        await signedIn(rig)
        rig.auth.logoutResult = .failure(.unreachable(.notConnectedToInternet))
        await rig.session.signOut()
        #expect(rig.session.state == .signedOut(.userRequested))
        #expect(try rig.store.readToken() == nil)
    }

    @Test("sign-out whose local clear fails says so, and still asks the server to revoke")
    func clearFails() async {
        let rig = Rig(token: Fixture.tokenA)
        await signedIn(rig)
        rig.store.fail(.clear)
        await rig.session.signOut()
        #expect(rig.session.state == .signedOut(.tokenNotRemoved))
        #expect(rig.auth.calls.last == .logout(Fixture.tokenA))
        #expect(SignedOutReason.tokenNotRemoved.notice != nil)
    }

    @Test("sign-out from the offline state works without the network")
    func signOutWhileOffline() async throws {
        let rig = Rig(token: Fixture.tokenA)
        rig.auth.meResult = .failure(.unreachable(.timedOut))
        _ = await rig.resolve()
        rig.auth.logoutResult = .failure(.unreachable(.timedOut))
        await rig.session.signOut()
        #expect(rig.session.state == .signedOut(.userRequested))
        #expect(try rig.store.readToken() == nil)
    }

    @Test("a 401 mid-session ends it as EXPIRED, not as a sign-out, and clears the token")
    func expiryMidSession() async throws {
        let rig = Rig(token: Fixture.tokenA)
        await signedIn(rig)
        rig.session.tokenRejected(Fixture.tokenA)
        #expect(rig.session.state == .signedOut(.sessionExpired))
        #expect(try rig.store.readToken() == nil)
        #expect(rig.session.state != .signedOut(.userRequested))
    }

    @Test("a late 401 for an OLD token does not sign out the session that replaced it")
    func lateRejection() async throws {
        let rig = Rig(token: Fixture.tokenA)
        await signedIn(rig)
        rig.auth.loginResult = .success(AuthSession(user: Fixture.otherUser, token: Fixture.tokenB))
        try await rig.session.signIn(email: "other@example.test", password: Fixture.password)
        rig.session.tokenRejected(Fixture.tokenA)
        #expect(rig.session.state == .signedIn(Fixture.otherUser))
        #expect(try rig.store.readToken() == Fixture.tokenB)
    }

    @Test("a rejection while signed out, resolving or offline changes nothing")
    func rejectionOutsideSignedIn() async {
        let rig = Rig()
        _ = await rig.resolve()
        rig.session.tokenRejected(Fixture.tokenA)
        #expect(rig.session.state == .signedOut(.noSession))

        let offline = Rig(token: Fixture.tokenA)
        offline.auth.meResult = .failure(.unreachable(.timedOut))
        let before = await offline.resolve()
        offline.session.tokenRejected(Fixture.tokenA)
        #expect(offline.session.state == before)
    }

    @Test("sign-out while the cold-start check is still in flight is not overwritten by its late answer")
    func signOutDuringResolve() async {
        let rig = Rig(token: Fixture.tokenA)
        let gate = Gate()
        rig.auth.meGate = gate
        let resolving = Task { await rig.session.resolve() }
        #expect(await waitUntil { rig.auth.calls == [.currentUser] })
        await rig.session.signOut()
        gate.open()
        await resolving.value
        #expect(rig.session.state == .signedOut(.userRequested))
    }

    @Test("signed-out states carry no user: nothing of the previous person can reach the login screen")
    func noUserInSignedOut() async {
        let rig = Rig(token: Fixture.tokenA)
        await signedIn(rig)
        rig.session.tokenRejected(Fixture.tokenA)
        let description = String(describing: rig.session.state)
        #expect(!description.contains(Fixture.email))
        #expect(!description.contains(Fixture.user.displayName))
        #expect(!description.contains(Fixture.user.id))
    }
}
