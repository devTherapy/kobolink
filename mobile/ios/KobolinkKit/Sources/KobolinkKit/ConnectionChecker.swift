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
///
/// Every check ends in a settled status: the screen never keeps spinning and
/// "Check again" never stays disabled. Overlapping calls (`.task` and
/// `.refreshable` firing together, a double tap) share one request.
@MainActor
@Observable
public final class ConnectionChecker {
    public enum Status: Equatable, Sendable {
        case checking
        case reachable
        /// A sentence the person can act on.
        case failed(String)
    }

    /// Shown when the very first check is cancelled before it could answer.
    public static let interruptedMessage = "The check was interrupted. Try again."

    public private(set) var status: Status = .checking

    private let api: any HealthChecking
    private var inFlight: Task<Void, Never>?

    public init(api: any HealthChecking) {
        self.api = api
    }

    public func check() async {
        if let inFlight {
            // The shared request is not tied to this caller, so this caller
            // being cancelled does not cancel it for the others.
            await inFlight.value
            return
        }
        let task = Task { await self.performCheck() }
        inFlight = task
        await task.value
        inFlight = nil
    }

    private func performCheck() async {
        let settled = status == .checking ? nil : status
        status = .checking
        do {
            try await api.health()
            status = .reachable
        } catch {
            if let message = error.userMessage {
                status = .failed(message)
            } else {
                // Cancelled: go back to whatever was known before, or say the
                // check did not finish. Never stay in `.checking`.
                status = settled ?? .failed(Self.interruptedMessage)
            }
        }
    }
}
