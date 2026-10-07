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
        "https://pay.folusayo.com/l/aBcDeFg%48", "https://example.com/anything", "http://pay.folusayo.com/l/aBcDeFgH",
    ])
    func web(url: String) throws {
        let url = try #require(URL(string: url))
        #expect(LinkRouting.resolve(url) == .external(try #require(ExternalLink(url))))
    }

    @Test("a kobolink URL that is not a link lands on the invalid screen with what was received", arguments: [
        "kobolink://dashboard", "kobolink://l/not-a-code", "kobolink://l/aBcDeFg%48", "kobolink://l//aBcDeFgH", "kobolink://", "kobolink://x/aBcDeFgH",
    ])
    func invalid(url: String) {
        #expect(LinkRouting.resolve(URL(string: url)!) == .destination(.invalid(url)))
    }

    @Test("Safari View Controller is only ever given http(s)")
    func externalLinkIsWebOnly() {
        #expect(ExternalLink(URL(string: "https://example.com")!) != nil)
        #expect(ExternalLink(URL(string: "http://example.com")!) != nil)
        for url in ["kobolink://dashboard", "ftp://example.com", "javascript:alert(1)", "file:///etc/passwd", "tel:123"] {
            #expect(ExternalLink(URL(string: url)!) == nil, "\(url)")
        }
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
