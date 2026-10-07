import Foundation
import Observation

/// Anything that can answer "is the API up". `KobolinkAPIClient` is the real
/// one; tests supply a stub.
public protocol HealthChecking: Sendable {
    func health() async throws(APIError)
}

extension KobolinkAPIClient: HealthChecking {}

/// Drives the first screen: ask the API whether it is healthy, remember the
/// answer in words the screen can show.
@MainActor
@Observable
public final class ConnectionChecker {
    public enum Status: Equatable, Sendable {
        case checking
        case reachable
        /// A sentence the person can act on.
        case failed(String)
    }

    public private(set) var status: Status = .checking

    private let api: any HealthChecking

    public init(api: any HealthChecking) {
        self.api = api
    }

    public func check() async {
        status = .checking
        do {
            try await api.health()
            status = .reachable
        } catch {
            // A cancelled check (the view went away) is not a failure to show.
            guard let message = error.userMessage else { return }
            status = .failed(message)
        }
    }
}
