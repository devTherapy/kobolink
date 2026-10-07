// swift-tools-version: 6.0
import PackageDescription

// The code generation toolchain, kept in its own package on purpose: Xcode
// builds a build-tool plugin's tools for the host only when the plugin lives
// in a different package from the target that uses it. Next to its consumer,
// the same tool is also built for the iOS Simulator, where the generator's
// core library refuses to compile.
let package = Package(
    name: "OpenAPITooling",
    // iOS is listed only because Xcode also compiles SpecNormalizer for the
    // app's destination when the app is built. The tools themselves run on
    // the Mac; run their tests with `swift test` in this directory.
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .plugin(name: "GenerateAPI", targets: ["GenerateAPI"])
    ],
    dependencies: [
        // upToNextMinor: openapi-generate uses the generator's underscore-prefixed
        // core library, which carries no compatibility promise across minors.
        .package(url: "https://github.com/apple/swift-openapi-generator", .upToNextMinor(from: "1.14.0"))
    ],
    targets: [
        // Rewrites the OpenAPI document into the dialect the generator reads
        // correctly (see SpecNormalizer.swift for what and why).
        .target(name: "SpecNormalizer"),
        .testTarget(name: "SpecNormalizerTests", dependencies: ["SpecNormalizer"]),

        // normalise -> run swift-openapi-generator in-process -> write Swift.
        .executableTarget(
            name: "openapi-generate",
            dependencies: [
                "SpecNormalizer",
                .product(name: "_OpenAPIGeneratorCore", package: "swift-openapi-generator"),
            ]
        ),

        // Runs openapi-generate on a target's openapi.json on every build.
        .plugin(name: "GenerateAPI", capability: .buildTool(), dependencies: ["openapi-generate"]),
    ]
)
