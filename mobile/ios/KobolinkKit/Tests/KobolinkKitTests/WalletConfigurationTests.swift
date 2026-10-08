import Foundation
import Testing

@testable import KobolinkKit

/// Pins the app's hand-kept configuration to what the wallet relies on. Read straight off disk, so a drift fails
/// here and not on a customer's phone.
@Suite("Wallet configuration")
struct WalletConfigurationTests {
    /// `mobile/ios/KobolinkKit/Tests/KobolinkKitTests/<this file>` is six levels below the repository root.
    private static let repositoryRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    private func plist(_ relative: String) throws -> [String: Any] {
        let data = try Data(contentsOf: Self.repositoryRoot.appending(path: relative))
        return try #require(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOf: Self.repositoryRoot.appending(path: relative), encoding: .utf8)
    }

    @Test("both Info.plists carry an honest camera purpose string, and it is the same one", arguments: [
        "mobile/ios/Kobolink/Info.plist", "mobile/ios/Kobolink/Info-Debug.plist",
    ])
    func cameraPurposeString(path: String) throws {
        let text = try #require(try plist(path)["NSCameraUsageDescription"] as? String, "\(path) has no NSCameraUsageDescription")
        #expect(text.contains("QR code"))
        #expect(text.contains("Nothing is recorded or saved"))
        #expect(text.count > 40, "a purpose string says what for")
    }

    @Test("Debug and Release say the same thing")
    func sameInBoth() throws {
        let release = try plist("mobile/ios/Kobolink/Info.plist")["NSCameraUsageDescription"] as? String
        let debug = try plist("mobile/ios/Kobolink/Info-Debug.plist")["NSCameraUsageDescription"] as? String
        #expect(release != nil && release == debug)
    }

    @Test("the app asks for the camera and nothing else: no photo library, microphone, location or contacts")
    func onlyTheCamera() throws {
        for path in ["mobile/ios/Kobolink/Info.plist", "mobile/ios/Kobolink/Info-Debug.plist"] {
            let keys = Set(try plist(path).keys)
            for forbidden in [
                "NSPhotoLibraryUsageDescription", "NSMicrophoneUsageDescription", "NSLocationWhenInUseUsageDescription",
                "NSContactsUsageDescription", "NSFaceIDUsageDescription",
            ] {
                #expect(!keys.contains(forbidden), "\(path): \(forbidden)")
            }
        }
    }

    @Test("the scanner records nothing: it has a metadata output for QR codes and no photo, movie or data output")
    func scannerOnlyReads() throws {
        let scanner = try source("mobile/ios/Kobolink/QRScannerView.swift")
        #expect(scanner.contains("AVCaptureMetadataOutput"))
        for forbidden in ["AVCapturePhotoOutput", "AVCaptureMovieFileOutput", "AVCaptureVideoDataOutput", "AVAssetWriter"] {
            #expect(!scanner.contains(forbidden), Comment(rawValue: forbidden))
        }
    }

    @Test("the camera is never started by a view appearing: permission is asked only from the Allow Camera button")
    func promptIsTheButtons() throws {
        let screen = try source("mobile/ios/Kobolink/ScanScreenView.swift")
        let access = try source("mobile/ios/Kobolink/SystemCameraAccess.swift")
        #expect(access.contains("requestAccess(for: .video)"))
        #expect(screen.contains("scan.allowCamera()"))
        #expect(!screen.contains("requestAccess"))
    }

    @Test("every wallet endpoint is secured in the API document, so each must carry the token")
    func walletEndpointsAreSecured() throws {
        let spec = try source("apps/api/openapi.json")
        let document = try #require(JSONSerialization.jsonObject(with: Data(spec.utf8)) as? [String: Any])
        let paths = try #require(document["paths"] as? [String: Any])
        var wallet: [String] = []
        for (path, item) in paths where path.hasPrefix("/api/wallet") {
            for (_, operation) in try #require(item as? [String: Any]) {
                guard let operation = operation as? [String: Any], let id = operation["operationId"] as? String else { continue }
                #expect(operation["security"] != nil, "\(id) is not secured in the document")
                wallet.append(id)
            }
        }
        #expect(Set(wallet).isSubset(of: AuthMiddleware.securedOperations), "\(wallet)")
        #expect(wallet.contains("transferMoney") && wallet.contains("getWallet") && wallet.contains("listWalletTransactions"))
    }

    @Test("the transfer request in the API document keeps the note optional and NOT nullable, and the amount bounds")
    func transferRequestShape() throws {
        let spec = try source("apps/api/openapi.json")
        let document = try #require(JSONSerialization.jsonObject(with: Data(spec.utf8)) as? [String: Any])
        let schemas = try #require((document["components"] as? [String: Any])?["schemas"] as? [String: Any])
        let request = try #require(schemas["TransferRequest"] as? [String: Any])
        let properties = try #require(request["properties"] as? [String: Any])
        let note = try #require(properties["note"] as? [String: Any])
        #expect(note["type"] as? String == "string", "a nullable note would be anyOf with null")
        #expect(note["anyOf"] == nil && note["nullable"] == nil)
        #expect((request["required"] as? [String]).map(Set.init) == ["toPhone", "amountKobo"])
        #expect(note["maxLength"] as? Int == TransferInstruction.noteMaxLength)
        let amount = try #require(properties["amountKobo"] as? [String: Any])
        #expect(amount["minimum"] as? Int == Kobo.minAmountKobo)
        #expect(amount["maximum"] as? Int == Kobo.maxAmountKobo)
    }
}
