import Foundation
import Testing

@testable import KobolinkKit

@Suite("Deep-link routing")
struct LinkRoutingTests {
    private let code = LinkCode("aBcDeFgH")!
    private let other = LinkCode("Zy9xWvUt")!

    @Test("both link forms resolve to the same destination", arguments: [
        "kobolink://l/aBcDeFgH", "https://pay.folusayo.com/l/aBcDeFgH", "https://pay.folusayo.com/l/aBcDeFgH/?utm=x#y",
    ])
    func linkForms(url: String) {
        #expect(LinkRouting.resolve(URL(string: url)!) == .destination(.link(code)))
    }

    @Test("another page of the web app opens in Safari View Controller, not dropped", arguments: [
        "https://pay.folusayo.com/dashboard", "https://pay.folusayo.com/", "https://pay.folusayo.com/l/", "https://pay.folusayo.com/l/short",
        "https://pay.folusayo.com/l/aBcDeFg%48", "https://PAY.FOLUSAYO.COM/dashboard", "https://pay.folusayo.com:443/dashboard",
        "https://user@pay.folusayo.com/dashboard",
    ])
    func web(url: String) throws {
        let url = try #require(URL(string: url))
        #expect(LinkRouting.resolve(url) == .external(try #require(ExternalLink(url))))
    }

    @Test("any other URL, from any entry point, goes to the invalid screen and never to an in-app browser", arguments: [
        "http://pay.folusayo.com/l/aBcDeFgH", "http://pay.folusayo.com/dashboard", "https://example.com/anything",
        "https://evil.example/l/aBcDeFgH", "https://pay.folusayo.com.evil.example/", "https://evilpay.folusayo.com/", "https://sub.pay.folusayo.com/",
        "https://pay.folusayo.com@evil.example/", "https://pay.folusayo.com:8443/dashboard", "https://pay.folusayo.com./dashboard", "https://pay%2Efolusayo.com/dashboard",
        "ftp://pay.folusayo.com/", "javascript:alert(1)", "file:///etc/hosts", "tel:123", "mailto:a@b.co",
    ])
    func notOurWeb(url: String) throws {
        let url = try #require(URL(string: url))
        #expect(ExternalLink(url) == nil)
        #expect(LinkRouting.resolve(url) == .destination(.invalid(url.absoluteString)))
    }

    @Test("a kobolink URL that is not a link lands on the invalid screen with what was received", arguments: [
        "kobolink://dashboard", "kobolink://l/not-a-code", "kobolink://l/aBcDeFg%48", "kobolink://l//aBcDeFgH", "kobolink://", "kobolink://x/aBcDeFgH",
    ])
    func invalid(url: String) {
        #expect(LinkRouting.resolve(URL(string: url)!) == .destination(.invalid(url)))
    }

    @Test("Safari View Controller is only ever given https on the verified host")
    func externalLinkIsOurHttpsOnly() {
        #expect(ExternalLink(URL(string: "https://pay.folusayo.com/dashboard")!) != nil)
        for url in ["https://example.com", "http://pay.folusayo.com", "kobolink://dashboard", "ftp://example.com", "javascript:alert(1)", "file:///etc/passwd", "tel:123"] {
            #expect(ExternalLink(URL(string: url)!) == nil, "\(url)")
        }
    }

    @Test("the host test reads the authority the way WebKit does", arguments: [
        ("https://pay.folusayo.com", true), ("https://pay.folusayo.com/", true), ("HTTPS://Pay.Folusayo.Com/x?y#z", true),
        ("https://pay.folusayo.com:443/x", true), ("https://pay.folusayo.com:/x", true), ("https://u:p@pay.folusayo.com/x", true),
        ("https:pay.folusayo.com/x", true), ("https:\\\\pay.folusayo.com\\x", true), (" https://pay.folusayo.com/x\n", true),
        ("https://evil.example\\@pay.folusayo.com/x", false), ("https://pay.folusayo.com@evil.example/x", false),
        ("https://pay.folusayo.com:8443/x", false), ("https://pay.folusayo.com.:443/x", false), ("http://pay.folusayo.com/x", false),
        ("//pay.folusayo.com/x", false), ("/l/aBcDeFgH", false), ("kobolink://l/aBcDeFgH", false), ("https://", false), ("", false),
    ] as [(String, Bool)])
    func hostTest(input: String, expected: Bool) {
        #expect(LinkCodeParser.isLinkHostWebURL(input) == expected, "\(input.debugDescription)")
    }

    @MainActor @Test("a link opens as the only destination above home")
    func opens() {
        let navigator = DeepLinkNavigator()
        navigator.open(URL(string: "kobolink://l/aBcDeFgH")!)
        #expect(navigator.path == [.link(code)])
        #expect(navigator.external == nil)
    }

    @MainActor @Test("a second link replaces the first, so Back always returns to home")
    func secondLinkReplaces() {
        let navigator = DeepLinkNavigator()
        navigator.open(URL(string: "kobolink://l/aBcDeFgH")!)
        navigator.open(URL(string: "https://pay.folusayo.com/l/Zy9xWvUt")!)
        #expect(navigator.path == [.link(other)])
        navigator.open(URL(string: "kobolink://l/aBcDeFgH")!)
        #expect(navigator.path == [.link(code)])
        navigator.open(URL(string: "kobolink://dashboard")!)
        #expect(navigator.path == [.invalid("kobolink://dashboard")])
    }

    @MainActor @Test("the same link twice (onOpenURL and onContinueUserActivity both firing) leaves one destination")
    func idempotent() {
        let navigator = DeepLinkNavigator()
        let url = URL(string: "https://pay.folusayo.com/l/aBcDeFgH")!
        navigator.open(url)
        navigator.open(url)
        #expect(navigator.path == [.link(code)])
    }

    @MainActor @Test("the result depends on the last link, not on the history")
    func deterministic() {
        let urls = ["kobolink://l/aBcDeFgH", "kobolink://dashboard", "https://pay.folusayo.com/l/Zy9xWvUt", "kobolink://l/aBcDeFgH"]
        let final = DeepLinkNavigator()
        final.open(URL(string: urls.last!)!)
        let replayed = DeepLinkNavigator()
        for url in urls { replayed.open(URL(string: url)!) }
        #expect(replayed.path == final.path)
    }

    @MainActor @Test("a web page opens over the current screen and leaves the link open underneath")
    func externalKeepsPath() throws {
        let navigator = DeepLinkNavigator()
        navigator.open(URL(string: "kobolink://l/aBcDeFgH")!)
        navigator.open(URL(string: "https://pay.folusayo.com/dashboard")!)
        #expect(navigator.path == [.link(code)])
        #expect(navigator.external == ExternalLink(URL(string: "https://pay.folusayo.com/dashboard")!))
    }

    @MainActor @Test("a link supersedes a web page that is still open")
    func linkDismissesWeb() {
        let navigator = DeepLinkNavigator()
        navigator.open(URL(string: "https://pay.folusayo.com/dashboard")!)
        navigator.open(URL(string: "kobolink://l/aBcDeFgH")!)
        #expect(navigator.external == nil)
        #expect(navigator.path == [.link(code)])
    }

    @MainActor @Test("dismissing the web page clears it, so the same page presents again")
    func closeExternalAllowsRepeat() throws {
        let navigator = DeepLinkNavigator()
        let page = URL(string: "https://pay.folusayo.com/dashboard")!
        navigator.open(page)
        #expect(navigator.external != nil)
        navigator.closeExternal()
        #expect(navigator.external == nil)
        navigator.open(page)
        #expect(navigator.external == ExternalLink(page))
    }

    // Cold start: SwiftUI may run the scene's .task (restore) before or after onOpenURL.
    @MainActor @Test("launched by a web page, restore first: the saved link is cleared, not left under Safari")
    func restoreThenLaunchedByWebPage() {
        let navigator = DeepLinkNavigator()
        navigator.restore(code)
        navigator.open(URL(string: "https://pay.folusayo.com/dashboard")!)
        #expect(navigator.path.isEmpty)
        #expect(navigator.external == ExternalLink(URL(string: "https://pay.folusayo.com/dashboard")!))
    }

    @MainActor @Test("launched by a web page, open first: the saved link is never restored")
    func launchedByWebPageThenRestore() {
        let navigator = DeepLinkNavigator()
        navigator.open(URL(string: "https://pay.folusayo.com/dashboard")!)
        navigator.restore(code)
        #expect(navigator.path.isEmpty)
        #expect(navigator.external != nil)
    }

    @MainActor @Test("launched by a link, either order: the launching link wins over the saved one")
    func launchedByLinkEitherOrder() {
        let restoreFirst = DeepLinkNavigator()
        restoreFirst.restore(code)
        restoreFirst.open(URL(string: "kobolink://l/Zy9xWvUt")!)
        #expect(restoreFirst.path == [.link(other)])

        let openFirst = DeepLinkNavigator()
        openFirst.open(URL(string: "kobolink://l/Zy9xWvUt")!)
        openFirst.restore(code)
        #expect(openFirst.path == [.link(other)])
    }

    @MainActor @Test("launched by an unexpected URL, either order: it is the invalid screen, with no stale link under it")
    func launchedByUnexpectedURL() {
        let url = URL(string: "https://evil.example/l/aBcDeFgH")!
        let restoreFirst = DeepLinkNavigator()
        restoreFirst.restore(code)
        restoreFirst.open(url)
        #expect(restoreFirst.path == [.invalid(url.absoluteString)])
        #expect(restoreFirst.external == nil)

        let openFirst = DeepLinkNavigator()
        openFirst.open(url)
        openFirst.restore(code)
        #expect(openFirst.path == [.invalid(url.absoluteString)])
    }

    @MainActor @Test("with nothing launching the app, the saved link is restored once, and Back is not undone")
    func restoreAlone() {
        let navigator = DeepLinkNavigator()
        navigator.restore(code)
        #expect(navigator.path == [.link(code)])
        navigator.path = []  // the person goes back to home
        navigator.restore(code)  // a repeated .task must not push it again
        #expect(navigator.path.isEmpty)
    }

    @MainActor @Test("restoring puts the saved link back, and never overrides a link that launched the app")
    func restore() {
        let restored = DeepLinkNavigator()
        restored.restore(code)
        #expect(restored.path == [.link(code)])

        let launched = DeepLinkNavigator()
        launched.open(URL(string: "kobolink://l/Zy9xWvUt")!)
        launched.restore(code)
        #expect(launched.path == [.link(other)])

        let nothing = DeepLinkNavigator()
        nothing.restore(nil)
        #expect(nothing.path.isEmpty)
    }

    @Test("only a payment link carries a code, so only it is saved for restoration")
    func destinationCode() {
        #expect(LinkDestination.link(code).code == code)
        #expect(LinkDestination.invalid("kobolink://x").code == nil)
    }

    @Test("a link code survives a Codable round trip and refuses a bad one")
    func codable() throws {
        let data = try JSONEncoder().encode([code])
        #expect(try JSONDecoder().decode([LinkCode].self, from: data) == [code])
        #expect(throws: DecodingError.self) { try JSONDecoder().decode([LinkCode].self, from: Data(#"["abcdefg0"]"#.utf8)) }
    }
}
