import Foundation

/// Where the API lives. The value comes from the build, never from source:
/// `Config/*.xcconfig` sets `KOBOLINK_API_BASE_URL`, the app's Info.plist
/// carries it as `KobolinkAPIBaseURL`, and this type reads it back. No secret
/// travels this way, only a host.
public struct APIConfiguration: Equatable, Sendable {
    public static let infoPlistKey = "KobolinkAPIBaseURL"

    /// What the build is allowed to point at.
    public enum Policy: Equatable, Sendable {
        /// Development: cleartext http is fine (`http://localhost:3001`).
        case debug
        /// Shipping: https only.
        case release

        /// The policy of the build this code was compiled into.
        public static var current: Policy {
            #if DEBUG
            .debug
            #else
            .release
            #endif
        }
    }

    public enum Problem: Error, Equatable, Sendable {
        /// The Info.plist has no `KobolinkAPIBaseURL`.
        case missing
        /// Empty, or still the literal `$(KOBOLINK_API_BASE_URL)`: the build
        /// setting was not defined, so Xcode did not substitute it.
        case unresolved(String)
        /// Present but not an absolute http(s) URL with a host.
        case invalid(String)
        /// A cleartext http URL in a build that must use https.
        case insecure(String)
        /// A path, query or fragment: the generated operations already begin
        /// with `/api`, so `https://host/api` would request `/api/api/...`.
        case hasPath(String)
    }

    public let baseURL: URL

    public init(baseURL: URL) {
        self.baseURL = baseURL
    }

    /// Read the base URL from an Info.plist dictionary.
    public init(infoDictionary: [String: Any]?, policy: Policy = .current) throws(Problem) {
        guard let raw = infoDictionary?[Self.infoPlistKey] as? String else { throw .missing }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed.contains("$(") { throw .unresolved(trimmed) }
        guard let url = URL(string: trimmed),
            let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
            let host = url.host(), !host.isEmpty
        else { throw .invalid(trimmed) }
        if policy == .release && scheme != "https" { throw .insecure(trimmed) }
        if !(url.path.isEmpty || url.path == "/") || url.query != nil || url.fragment != nil {
            throw .hasPath(trimmed)
        }
        self.baseURL = url
    }

    public init(bundle: Bundle = .main, policy: Policy = .current) throws(Problem) {
        try self.init(infoDictionary: bundle.infoDictionary, policy: policy)
    }

    /// The host, for showing the person which server they are talking to.
    public var host: String { baseURL.host() ?? baseURL.absoluteString }
}
