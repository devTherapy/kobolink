// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "KobolinkKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "KobolinkKit", targets: ["KobolinkKit"])
    ],
    dependencies: [
        .package(path: "../OpenAPITooling"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.13.0"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.3.0"),
        .package(url: "https://github.com/apple/swift-http-types", from: "1.4.0"),
    ],
    targets: [
        // The generated models and operations. Contains no hand-written
        // code: `openapi.json` is a symlink to apps/api/openapi.json, and the
        // GenerateAPI plugin (OpenAPITooling) turns it into Swift on every build.
        .target(
            name: "KobolinkAPI",
            dependencies: [
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime")
            ],
            exclude: ["openapi.json"],
            plugins: [.plugin(name: "GenerateAPI", package: "OpenAPITooling")]
        ),

        // Hand-written: the typed client, config and view model the app uses.
        .target(
            name: "KobolinkKit",
            dependencies: [
                "KobolinkAPI",
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
            ]
        ),

        .testTarget(
            name: "KobolinkKitTests",
            dependencies: [
                "KobolinkKit",
                "KobolinkAPI",
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "HTTPTypes", package: "swift-http-types"),
            ]
        ),
    ]
)
