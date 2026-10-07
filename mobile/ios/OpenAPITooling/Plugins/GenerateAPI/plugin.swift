import Foundation
import PackagePlugin

/// Build-tool plugin: generate the Swift models and client from
/// `openapi.json` on every build of the target that uses it.
///
/// The tool declares the document as its input and the generated files as its
/// outputs, so SwiftPM and Xcode re-run it exactly when the document (or the
/// tool) changes. The files land in the plugin work directory under the build
/// folder: nothing generated is checked in, so nothing can go stale. See
/// `Sources/openapi-generate/main.swift` for what the tool does.
@main
struct GenerateAPIPlugin: BuildToolPlugin {
    func createBuildCommands(context: PluginContext, target: Target) async throws -> [Command] {
        guard let target = target as? SwiftSourceModuleTarget else {
            throw PluginError("GenerateAPI only applies to Swift source targets, not \(target.name)")
        }
        let spec = target.directoryURL.appending(path: "openapi.json")
        guard FileManager.default.fileExists(atPath: spec.path) else {
            throw PluginError("\(target.name) has no openapi.json (expected at \(spec.path))")
        }

        let generatedDirectory = context.pluginWorkDirectoryURL.appending(path: "GeneratedSources")
        // Exactly the files the generator writes for the `types` and `client` modes.
        let outputs = [
            "Types.swift", "Types+Components.swift", "Types+Operations.swift",
            "Types+Components+Schemas.swift", "Types+Components+Parameters.swift",
            "Types+Components+RequestBodies.swift", "Types+Components+Responses.swift",
            "Types+Components+Headers.swift", "Client.swift",
        ].map { generatedDirectory.appending(path: $0) }

        return [
            .buildCommand(
                displayName: "Generating Swift from openapi.json",
                executable: try context.tool(named: "openapi-generate").url,
                arguments: [spec.path, generatedDirectory.path],
                inputFiles: [spec],
                outputFiles: outputs
            )
        ]
    }
}

struct PluginError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
