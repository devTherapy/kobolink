import Foundation
import KobolinkAPI

/// Who is signed in, as much of `User` as the app shows. The API describes the same user inline in
/// `AuthResponse` and in `MeResponse`, so the generator emits two unrelated types; this one is where
/// both land.
public struct SignedInUser: Equatable, Hashable, Sendable {
    public enum Role: String, Equatable, Hashable, Sendable {
        case merchant
        case customer
    }

    public let id: String
    public let email: String
    public let displayName: String
    public let role: Role

    public init(id: String, email: String, displayName: String, role: Role) {
        self.id = id
        self.email = email
        self.displayName = displayName
        self.role = role
    }
}

/// What a successful sign-in returns: the user, and the session token for the Keychain.
///
/// `token` is `nil` when the server answered 200 without one (the contract makes it optional because
/// web sessions use a cookie instead); the caller treats that as a failed sign-in.
public struct AuthSession: Equatable, Sendable {
    public let user: SignedInUser
    public let token: SessionToken?

    public init(user: SignedInUser, token: SessionToken?) {
        self.user = user
        self.token = token
    }
}

/// The three auth calls the session layer needs. `KobolinkAPIClient` is the real one; tests supply
/// a script.
public protocol AuthServing: Sendable {
    /// `POST /api/auth/login` as a mobile client. Sends no credential header: the person is proving
    /// who they are, and an old token must not ride along.
    func login(email: String, password: String) async throws(APIError) -> AuthSession
    /// `GET /api/auth/me` with the stored token: the round trip that proves the server still honours it.
    func currentUser() async throws(APIError) -> SignedInUser
    /// `POST /api/auth/logout`, authenticated by `token` itself rather than by whatever the store holds,
    /// so the revoke can go out after the local copy has already been removed.
    func logout(revoking token: SessionToken) async throws(APIError)
}

extension Components.Schemas.AuthResponse.userPayload {
    var signedInUser: SignedInUser {
        SignedInUser(id: id, email: email, displayName: displayName, role: .init(role.rawValue))
    }
}

extension Components.Schemas.MeResponse.userPayload {
    var signedInUser: SignedInUser {
        SignedInUser(id: id, email: email, displayName: displayName, role: .init(role.rawValue))
    }
}

extension SignedInUser.Role {
    fileprivate init(_ wire: String) {
        // A role this build does not know is the least privileged one it does.
        self = Self(rawValue: wire) ?? .customer
    }
}
