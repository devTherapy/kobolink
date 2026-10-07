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

    /// Every non-comment line that sets `name`, in any spelling Xcode accepts: indented, with a
    /// condition (`CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*]`), or with spaces around `=`.
    private func assignments(of name: String, in text: String) -> [String] {
        text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.hasPrefix("//") && $0.hasPrefix(name) }
            .filter { line in
                let rest = line.dropFirst(name.count).drop { $0 == " " || $0 == "\t" }
                return rest.first == "=" || rest.first == "["
            }
    }

    @Test("only Release.xcconfig sets the entitlement; Debug and Base (every Simulator and free-team run) must not")
    func entitlementIsReleaseOnly() throws {
        let name = "CODE_SIGN_ENTITLEMENTS"
        let release = assignments(of: name, in: try file("mobile/ios/Config/Release.xcconfig"))
        #expect(release.count == 1, "\(release)")
        #expect(release.first.map { $0.filter { !$0.isWhitespace } } == "\(name)=Config/Kobolink.entitlements")
        for config in ["Base", "Debug", "Local.xcconfig.example"] {
            let path = config.contains(".") ? config : "\(config).xcconfig"
            #expect(assignments(of: name, in: try file("mobile/ios/Config/\(path)")).isEmpty, "\(path)")
        }
        // Xcode's Signing & Capabilities editor writes into the project file, which every configuration reads.
        let project = try file("mobile/ios/Kobolink.xcodeproj/project.pbxproj")
        #expect(!project.contains(name), "set it in Release.xcconfig only, not in the project")
        #expect(!project.contains("com.apple.developer.associated-domains"))
        #expect(!project.contains("DEVELOPMENT_TEAM"), "set the team in Release.xcconfig (or Local.xcconfig for Debug), not in the project")
    }

    @Test("the checker itself catches the spellings that would slip past a plain prefix test")
    func assignmentsCheckerIsRobust() {
        let name = "CODE_SIGN_ENTITLEMENTS"
        for line in [
            "CODE_SIGN_ENTITLEMENTS = x", "   CODE_SIGN_ENTITLEMENTS = x", "\tCODE_SIGN_ENTITLEMENTS=x",
            "CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*] = x", "CODE_SIGN_ENTITLEMENTS  =  x",
        ] {
            #expect(assignments(of: name, in: "A = 1\n\(line)\nB = 2").count == 1, "\(line.debugDescription)")
        }
        for line in ["// CODE_SIGN_ENTITLEMENTS = x", "  // CODE_SIGN_ENTITLEMENTS = x", "OTHER_CODE_SIGN_ENTITLEMENTS = x", "CODE_SIGN_ENTITLEMENTS_X = x"] {
            #expect(assignments(of: name, in: line).isEmpty, "\(line.debugDescription)")
        }
    }

    @Test("the web app serves the association file this wiring relies on")
    func webServesTheAssociationFile() throws {
        let route = try file("apps/web/src/app/.well-known/apple-app-site-association/route.ts")
        #expect(route.contains("APPLE_APP_ID"))
        let shared = try file("packages/contracts/src/routes.ts")
        #expect(shared.contains("CLAIMED_PATH_PATTERN = '/l/*'"))
    }
}
