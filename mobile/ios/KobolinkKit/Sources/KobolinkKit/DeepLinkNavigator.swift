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

/// A page of the Kobolink web app the app hands to `SFSafariViewController`.
///
/// Only `https` on the verified link host (`pay.folusayo.com`, no port or 443). An in-app browser
/// that opened any URL an entry point handed it would be a phishing surface: it shows a real
/// browser's chrome around someone else's page, inside an app the person trusts. The host test is
/// `LinkCodeParser.isLinkHostWebURL`, which reads the authority the way WebKit will.
public struct ExternalLink: Identifiable, Equatable, Sendable {
    public let url: URL
    public var id: URL { url }

    public init?(_ url: URL) {
        guard LinkCodeParser.isLinkHostWebURL(url) else { return nil }
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
    /// - Any other page of the web app (`https://pay.folusayo.com/dashboard`) opens in Safari View
    ///   Controller rather than being dropped.
    /// - Anything else lands on the invalid-link screen: a `kobolink://` URL that is not a link, a
    ///   malformed code, and any URL that is not `https` on the verified host, however it arrived.
    ///   A link that does nothing is worse than one that says why, and an unexpected URL is never
    ///   shown in a browser frame.
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

    /// Has any URL been handed to `open` yet? A restored link must not override one.
    private var handledURL = false
    /// Is `path` the link saved from the last session, not one the person (or the system) just opened?
    private var pathIsRestored = false
    /// Restoring happens once per launch; a later `.task` re-run must not undo the person going Back.
    private var restoreAttempted = false

    public init() {}

    /// Handle any URL the system hands the app, from a cold or a warm start.
    public func open(_ url: URL) {
        handledURL = true
        switch LinkRouting.resolve(url) {
        case .destination(let destination):
            // A link supersedes a web page that was open on top of the stack.
            external = nil
            show(destination)
        case .external(let link):
            if pathIsRestored {
                // The app was launched to show this page, so the link saved from last time must not
                // sit underneath it, whichever of restore and open ran first.
                path = []
                pathIsRestored = false
            }
            external = link
        }
    }

    /// The web page was dismissed (the Done button, or a swipe). Clear it so the same page can be
    /// presented again.
    public func closeExternal() {
        external = nil
    }

    /// Re-open the link that was open when the scene was last saved. Does nothing once any URL has
    /// been handled, so a link that launched the app wins; and if a URL arrives afterwards, `open`
    /// replaces or clears what this put on the stack.
    public func restore(_ code: LinkCode?) {
        guard !restoreAttempted else { return }
        restoreAttempted = true
        guard let code, !handledURL, path.isEmpty else { return }
        path = [.link(code)]
        pathIsRestored = true
    }

    private func show(_ destination: LinkDestination) {
        pathIsRestored = false
        if path != [destination] { path = [destination] }
    }
}
