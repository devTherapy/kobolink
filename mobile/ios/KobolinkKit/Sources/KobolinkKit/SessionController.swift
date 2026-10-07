import Foundation
import Observation

/// Why there is no session. The login screen words each differently; only `sessionExpired` is not
/// something the person asked for.
public enum SignedOutReason: Equatable, Sendable {
    /// Nothing was stored: first run, or a fresh install.
    case noSession
    /// The person chose Sign out.
    case userRequested
    /// The server rejected the stored token (401): it expired or was revoked. Involuntary.
    case sessionExpired
    /// The person chose Sign out, but this device could not remove the saved token. The server
    /// session was revoked if the network allowed.
    case tokenNotRemoved

    /// A sentence for the login screen, or `nil` when the person needs no explanation.
    public var notice: String? {
        switch self {
        case .noSession, .userRequested:
            nil
        case .sessionExpired:
            "Your session ended. Sign in again to continue."
        case .tokenNotRemoved:
            "You're signed out, but this device couldn't remove your saved session. Restart Kobolink and sign out again."
        }
    }
}

/// Where the app is in the sign-in lifecycle.
public enum SessionState: Equatable, Sendable {
    /// Cold start with a stored token that has not been checked against the server yet.
    case resolving
    case signedOut(SignedOutReason)
    case signedIn(SignedInUser)
    /// A token is stored but the server could not confirm it (no network, a timeout, a 5xx). The
    /// token is kept and the person is still signed in as far as this device knows.
    case offline(message: String)
    /// The Keychain could not be read, so it is unknown whether a session exists. This is neither
    /// "signed out" (a token may be there) nor an excuse to keep a token anywhere else.
    case storageUnavailable
}

/// Why a sign-in did not complete.
public enum SignInFailure: Error, Equatable, Sendable {
    /// Another sign-in is already running.
    case busy
    case api(APIError)
    /// The server said yes but sent no usable token.
    case missingToken
    /// The Keychain refused the token, so the person was NOT signed in.
    case storage
}

/// What the login form needs from the session layer.
@MainActor
public protocol SigningIn: AnyObject {
    func signIn(email: String, password: String) async throws(SignInFailure)
}

/// Every decision about the session: the cold-start check, sign-in, sign-out, and a 401 mid-session.
/// Pure Swift over `AuthServing`, `TokenStore` and `InstallMarker`, so all of it runs in unit tests.
///
/// The invariants:
/// - A saved token is destroyed only by an explicit sign-out, a definitive 401, or the purge of a
///   fresh install. Offline, a timeout and a 5xx keep it.
/// - A token that cannot be READ is not "no token": the state is `storageUnavailable`, with a retry,
///   and nothing is written anywhere else.
/// - Signing out clears the device first (the token is removed and the state changes before any
///   network call), then asks the server to revoke. Being offline cannot leave the device signed in.
/// - An involuntary end (`sessionExpired`) and a chosen one (`userRequested`) are different states.
///   Neither carries the previous user into the signed-out state.
/// - Work that must not be cut in half (the login request and the Keychain write after it) runs in a
///   task the caller's cancellation cannot reach.
@MainActor
@Observable
public final class SessionController: SigningIn {
    public private(set) var state: SessionState = .resolving

    @ObservationIgnored private let auth: any AuthServing
    @ObservationIgnored private let store: any TokenStore
    @ObservationIgnored private let installMarker: any InstallMarker

    /// Bumped by every change the person (or the server) makes to the session, so a slow cold-start
    /// check that finishes afterwards cannot overwrite it.
    @ObservationIgnored private var epoch = 0
    @ObservationIgnored private var resolveStarted = false
    @ObservationIgnored private var signInInFlight = false

    public init(auth: any AuthServing, store: any TokenStore, installMarker: any InstallMarker) {
        self.auth = auth
        self.store = store
        self.installMarker = installMarker
    }

    /// The cold-start check. Once per launch: a second call (the root view's task running again) does nothing.
    public func resolve() async {
        guard !resolveStarted else { return }
        resolveStarted = true
        await runCheck()
    }

    /// Re-run the check after `offline` or `storageUnavailable`; ignored in any other state.
    public func retry() async {
        switch state {
        case .offline, .storageUnavailable:
            state = .resolving
            await runCheck()
        case .resolving, .signedOut, .signedIn:
            return
        }
    }

    // MARK: Cold start

    private func runCheck() async {
        let startedAt = epoch
        // Unstructured: the root view's `.task` being cancelled must not leave the state at `resolving` for good.
        await Task { await self.check(startedAt: startedAt) }.value
    }

    private func check(startedAt: Int) async {
        let token: SessionToken
        do throws(TokenStoreError) {
            try purgeIfFreshInstall()
            guard let stored = try store.readToken() else {
                finish(.signedOut(.noSession), ifEpoch: startedAt)
                return
            }
            token = stored
        } catch {
            if error.kind == .corrupt {
                // Something is in the slot that this app did not write and cannot use. It is not a
                // session; remove it. If even that fails, the next launch tries again.
                try? store.clearToken()
                finish(.signedOut(.sessionExpired), ifEpoch: startedAt)
            } else {
                finish(.storageUnavailable, ifEpoch: startedAt)
            }
            return
        }

        do throws(APIError) {
            let user = try await auth.currentUser()
            finish(.signedIn(user), ifEpoch: startedAt)
        } catch {
            if error.isUnauthenticated {
                // Definitive: the server does not honour this token. A failed removal must not stop
                // the move to signed-out; the next launch gets the same 401 and tries again.
                discardIfStillStored(token)
                finish(.signedOut(.sessionExpired), ifEpoch: startedAt)
            } else {
                finish(.offline(message: Self.offlineMessage(for: error)), ifEpoch: startedAt)
            }
        }
    }

    private func finish(_ new: SessionState, ifEpoch startedAt: Int) {
        guard epoch == startedAt else { return }
        state = new
    }

    /// The Keychain outlives the app, so an install with no marker is either brand new or a
    /// reinstall, and a token already in the Keychain is not this install's to trust. The marker is
    /// set only after the purge succeeded, so a failed purge is retried and never skipped.
    private func purgeIfFreshInstall() throws(TokenStoreError) {
        guard !installMarker.isSet else { return }
        try store.clearToken()
        installMarker.set()
    }

    private func discardIfStillStored(_ token: SessionToken) {
        if let current = try? store.readToken(), current != token { return }
        try? store.clearToken()
    }

    private static func offlineMessage(for error: APIError) -> String {
        switch error {
        case .unreachable:
            "Kobolink can't reach its server, so it can't confirm you're still signed in. You haven't been signed out."
        default:
            "Kobolink's server had a problem confirming your session. You haven't been signed out. Try again in a moment."
        }
    }

    // MARK: Sign in

    /// Sign in and keep the token in the Keychain. On success the state is `signedIn`; on any failure
    /// nothing is saved and the state is unchanged.
    ///
    /// The request and the Keychain write run in a task the caller's cancellation cannot reach: a
    /// screen disappearing must not land between "the server accepted" and "the token is saved",
    /// which would leave a live session nobody holds.
    public func signIn(email: String, password: String) async throws(SignInFailure) {
        guard !signInInFlight else { throw .busy }
        signInInFlight = true
        defer { signInInFlight = false }
        let result = await Task { await self.performSignIn(email: email, password: password) }.value
        try result.get()
    }

    private func performSignIn(email: String, password: String) async -> Result<Void, SignInFailure> {
        let session: AuthSession
        do throws(APIError) {
            session = try await auth.login(email: email, password: password)
        } catch {
            return .failure(.api(error))
        }
        guard let token = session.token else { return .failure(.missingToken) }

        do throws(TokenStoreError) {
            try store.saveToken(token)
        } catch {
            // The server created a session the device cannot keep. Revoke it rather than leave it live.
            await revokeQuietly(token)
            return .failure(.storage)
        }
        epoch += 1
        state = .signedIn(session.user)
        return .success(())
    }

    // MARK: Sign out

    /// Explicit sign-out. The token is removed and the state leaves `signedIn` before the network is
    /// touched; the revoke that follows is best effort and cannot keep the person signed in.
    public func signOut() async {
        epoch += 1
        let token = try? store.readToken()
        do throws(TokenStoreError) {
            try store.clearToken()
            state = .signedOut(.userRequested)
        } catch {
            state = .signedOut(.tokenNotRemoved)
        }
        if let token { await revokeQuietly(token) }
    }

    /// A 401 to a request that carried `token` (reported by `AuthMiddleware`). If that token is still
    /// the stored one and the person is signed in, the session is over: clear it and say so. A late 401
    /// for an old token is ignored, so it cannot sign out the session that replaced it.
    public func tokenRejected(_ token: SessionToken) {
        guard case .signedIn = state else { return }
        if let current = try? store.readToken(), current != token { return }
        epoch += 1
        try? store.clearToken()
        state = .signedOut(.sessionExpired)
    }

    private func revokeQuietly(_ token: SessionToken) async {
        // Errors are deliberately dropped: the local session is already gone, and "the server
        // could not be told" does not change what the person sees.
        try? await auth.logout(revoking: token)
    }
}
