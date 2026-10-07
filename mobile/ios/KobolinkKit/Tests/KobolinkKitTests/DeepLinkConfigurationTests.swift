import Foundation
import Testing

@testable import KobolinkKit

/// Pins the hand-kept constants to the files they must agree with, the way Android's
/// `DeepLinkTest` and `AndroidManifestDeepLinkTest` do. These read the repository straight
/// off disk (the tests run on the Mac, from a checkout), so a drift fails here and not on a
/// customer's phone.
@Suite("Deep-link configuration")
struct DeepLinkConfigurationTests {
    /// `mobile/ios/KobolinkKit/Tests/KobolinkKitTests/<this file>` is six levels below the repository root.
    private static let repositoryRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    private func file(_ relative: String) throws -> String {
        try String(contentsOf: Self.repositoryRoot.appending(path: relative), encoding: .utf8)
    }

    private func plist(_ relative: String) throws -> [String: Any] {
        let data = try Data(contentsOf: Self.repositoryRoot.appending(path: relative))
        return try #require(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    }

    private func contractsConstant(_ name: String) throws -> String {
        let source = try file("packages/contracts/src/routes.ts")
        let pattern = try Regex("export const \(name) = '([^']+)'")
        let match = try #require(source.firstMatch(of: pattern), "no `export const \(name) = '...'` in routes.ts")
        return try #require(match.output[1].substring).description
    }

    @Test("the constants are the ones in packages/contracts/src/routes.ts")
    func constantsMatchContracts() throws {
        #expect(LinkCodeParser.linkHost == (try contractsConstant("LINK_DOMAIN")))
        #expect(LinkCodeParser.customScheme == (try contractsConstant("IOS_URL_SCHEME")))
        #expect(LinkCodeParser.pathPrefix == (try contractsConstant("LINK_PATH_PREFIX")))
        #expect(LinkCode.length == 8)
    }

    @Test("the code shape is the pattern generated into the OpenAPI document")
    func codePatternMatchesOpenAPI() throws {
        let spec = try file("apps/api/openapi.json")
        #expect(spec.contains("^[2-9A-HJ-NP-Za-km-z]{8}$"))
        let alphabet = try #require(
            try file("packages/contracts/src/code.ts").firstMatch(of: try Regex("const ALPHABET = '([^']+)'"))?.output[1].substring
        )
        for byte in alphabet.utf8 {
            #expect(LinkCode(String(repeating: String(UnicodeScalar(byte)), count: 8)) != nil)
        }
        #expect(alphabet.count == 57)
    }

    @Test("both Info.plists register the kobolink scheme, so Debug and Release both open kobolink://", arguments: [
        "mobile/ios/Kobolink/Info.plist", "mobile/ios/Kobolink/Info-Debug.plist",
    ])
    func urlSchemeIsRegistered(path: String) throws {
        let types = try #require(try plist(path)["CFBundleURLTypes"] as? [[String: Any]])
        let schemes = types.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        #expect(schemes == [LinkCodeParser.customScheme])
    }

    @Test("the universal-link entitlement names the link host")
    func entitlementNamesTheHost() throws {
        let entitlements = try plist("mobile/ios/Config/Kobolink.entitlements")
        #expect(entitlements["com.apple.developer.associated-domains"] as? [String] == ["applinks:\(LinkCodeParser.linkHost)"])
    }

    @Test("only Release references the entitlement; Debug (every Simulator and free-team run) must not")
    func entitlementIsReleaseOnly() throws {
        func setting(_ name: String, in text: String) -> [Substring] {
            text.split(separator: "\n").filter { $0.hasPrefix(name) }
        }
        let release = try file("mobile/ios/Config/Release.xcconfig")
        #expect(setting("CODE_SIGN_ENTITLEMENTS", in: release) == ["CODE_SIGN_ENTITLEMENTS = Config/Kobolink.entitlements"])
        for config in ["Base", "Debug"] {
            #expect(setting("CODE_SIGN_ENTITLEMENTS", in: try file("mobile/ios/Config/\(config).xcconfig")).isEmpty, "\(config).xcconfig")
        }
        let project = try file("mobile/ios/Kobolink.xcodeproj/project.pbxproj")
        #expect(!project.contains("CODE_SIGN_ENTITLEMENTS"), "set it in Release.xcconfig only, not in the project")
        #expect(!project.contains("com.apple.developer.associated-domains"))
    }

    @Test("the web app serves the association file this wiring relies on")
    func webServesTheAssociationFile() throws {
        let route = try file("apps/web/src/app/.well-known/apple-app-site-association/route.ts")
        #expect(route.contains("APPLE_APP_ID"))
        let shared = try file("packages/contracts/src/routes.ts")
        #expect(shared.contains("CLAIMED_PATH_PATTERN = '/l/*'"))
    }
}
