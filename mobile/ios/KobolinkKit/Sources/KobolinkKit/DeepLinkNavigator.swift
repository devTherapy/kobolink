import Foundation
import Observation

/// A screen a deep link can land on.
public enum LinkDestination: Hashable, Sendable {
    /// A payment link, by its code.
    case link(LinkCode)
    /// A link that reached the app but names nothing the app can open.
    /// Carries the text received so the screen can say what was rejected.
    case invalid(String)

    /// The code, when this is a payment link.
    public var code: LinkCode? {
        if case .link(let code) = self { code } else { nil }
    }
}

/// A web page the app hands to `SFSafariViewController`. Only http(s), because
/// that is all Safari View Controller can show.
public struct ExternalLink: Identifiable, Equatable, Sendable {
    public let url: URL
    public var id: URL { url }

    public init?(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        self.url = url
    }
}

/// What a URL that reached the app means.
public enum IncomingLink: Equatable, Sendable {
    case destination(LinkDestination)
    case external(ExternalLink)
}

public enum LinkRouting {
    /// - A payment link (either form) lands on that link.
    /// - Any other http(s) URL, such as `https://pay.folusayo.com/dashboard`, is a page of the
    ///   web app: it opens in Safari View Controller rather than being dropped.
    /// - Anything else (a `kobolink://` URL that is not a link, so `kobolink://dashboard` or a
    ///   malformed code) lands on the invalid-link screen. Safari View Controller cannot show a
    ///   non-web URL, and a link that does nothing is worse than one that says why.
    public static func resolve(_ url: URL) -> IncomingLink {
        if let code = LinkCodeParser.parse(url) {
            return .destination(.link(code))
        }
        if let external = ExternalLink(url) {
            return .external(external)
        }
        return .destination(.invalid(url.absoluteString))
    }
}

/// The deep-link state of the app's one navigation stack.
///
/// Whatever arrives, there is at most one link on the stack above the home
/// screen: a second link replaces the first (it does not pile up behind it), so
/// "Back" always returns to home and the result never depends on how many links
/// were opened before. The same link twice leaves the stack unchanged; that matters
/// because SwiftUI can report one universal link through both `onOpenURL` and
/// `onContinueUserActivity`.
@MainActor
@Observable
public final class DeepLinkNavigator {
    /// Bound to the `NavigationStack`.
    public var path: [LinkDestination] = []
    /// The page to show in Safari View Controller, bound to its presentation.
    public var external: ExternalLink?

    public init() {}

    /// Handle any URL the system hands the app, from a cold or a warm start.
    public func open(_ url: URL) {
        switch LinkRouting.resolve(url) {
        case .destination(let destination):
            // A link supersedes a web page that was open on top of the stack.
            external = nil
            show(destination)
        case .external(let link):
            external = link
        }
    }

    /// Re-open the link that was open when the scene was last saved. Does nothing if
    /// something has already been opened, so a link that launched the app wins.
    public func restore(_ code: LinkCode?) {
        guard let code, path.isEmpty else { return }
        path = [.link(code)]
    }

    private func show(_ destination: LinkDestination) {
        if path != [destination] { path = [destination] }
    }
}
