import Foundation
import SpecNormalizer
import _OpenAPIGeneratorCore

// Usage: openapi-generate <openapi.json> <output-directory>
//
// Run by the GenerateAPI build plugin. Normalises the OpenAPI document (see
// SpecNormalizer), then runs swift-openapi-generator's pipeline in-process for
// the `types` and `client` modes with public access, and writes the Swift
// files into the output directory.
//
// Why in-process rather than shelling out to the generator's own tool: a build
// plugin that depends on another package's executable makes Xcode build that
// package's library for iOS too, which its own platform check rejects. A tool
// that lives in this package and links the core library builds for the host
// only, which is how Apple's own plugin is structured. The cost is using the
// underscore-prefixed core API, so Package.swift pins the generator to a
// minor version.

/// Fails the build on anything the generator says that is not a plain note.
///
/// An "unsupported schema" warning means the generator skipped part of the
/// contract, which is how a field silently disappears from a model. Apple's
/// own plugin prints these where nobody looks; here they stop the build.
struct StrictDiagnostics: DiagnosticCollector {
    struct Rejected: Error, CustomStringConvertible {
        let diagnostic: Diagnostic
        var description: String { "the generator reported a problem with the OpenAPI document: \(diagnostic)" }
    }

    func emit(_ diagnostic: Diagnostic) throws {
        FileHandle.standardError.write(Data((diagnostic.description + "\n").utf8))
        if diagnostic.severity != .note { throw Rejected(diagnostic: diagnostic) }
    }
}

func run() throws {
    let arguments = CommandLine.arguments
    guard arguments.count == 3 else {
        throw ValidationFailure("usage: openapi-generate <openapi.json> <output-directory>")
    }
    let documentURL = URL(fileURLWithPath: arguments[1])
    let outputDirectory = URL(fileURLWithPath: arguments[2], isDirectory: true)

    let normalized = try SpecNormalizer.normalize(Data(contentsOf: documentURL))
    try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

    for mode in [GeneratorMode.types, .client] {
        let config = Config(mode: mode, access: .public, namingStrategy: .defensive)
        let files = try runGenerator(
            input: InMemoryInputFile(absolutePath: documentURL, contents: normalized),
            config: config,
            diagnostics: StrictDiagnostics()
        )
        for file in files {
            try file.contents.write(to: outputDirectory.appending(path: file.baseName), options: .atomic)
        }
    }
}

struct ValidationFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

do {
    try run()
} catch {
    FileHandle.standardError.write(Data("error: \(error)\n".utf8))
    exit(1)
}
