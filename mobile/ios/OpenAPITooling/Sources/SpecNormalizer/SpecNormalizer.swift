import Foundation

/// Reshapes `apps/api/openapi.json` into the dialect swift-openapi-generator
/// reads correctly, on a copy, before generation. The document itself is
/// never edited (it is generated from `packages/contracts`, which this app
/// does not own).
///
/// Two constructs in the Zod-emitted OpenAPI 3.1 document need it:
///
/// 1. **Nullable fields.** Zod's `.nullable()` is emitted as
///    `anyOf: [T, {type: "null"}]`. The generator silently DROPS such a
///    property from the generated struct: `PublicLink` came out with no
///    `description`, `amountKobo` or `expiresAt`, and then threw on decode
///    because the payload carried keys the struct did not know. The 3.1
///    spelling it does understand is `type: [T, "null"]`, which generates an
///    optional that decodes from `null` and from an absent key alike.
///
/// 2. **`additionalProperties: false`.** Zod's `.strict()` objects carry it,
///    and the generator turns it into a decode that THROWS on any key it does
///    not know. A phone that has been installed for a year must keep working
///    when the API adds a response field, so the keyword is dropped: unknown
///    keys are ignored, as the Android client's Json does.
///
/// Anything nullable that this cannot rewrite is an error, never a skip: a
/// silently missing model field is the failure this type exists to prevent.
public enum SpecNormalizer {
    public struct Failure: Error, CustomStringConvertible, Equatable {
        public let path: String
        public let reason: String
        public var description: String { "openapi normalisation failed at \(path): \(reason)" }
    }

    /// Normalise a JSON OpenAPI document.
    public static func normalize(_ data: Data) throws -> Data {
        let root = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        let normalized = try normalize(node: root, path: "#")
        try assertNoNullBranchRemains(normalized, path: "#")
        return try JSONSerialization.data(
            withJSONObject: normalized,
            options: [.sortedKeys, .withoutEscapingSlashes]
        )
    }

    // MARK: - Rewrite

    private static func normalize(node: Any, path: String) throws -> Any {
        if let array = node as? [Any] {
            return try array.enumerated().map { try normalize(node: $1, path: "\(path)/\($0)") }
        }
        guard var object = node as? [String: Any] else { return node }

        // Children first, so a nullable inside a nullable's payload is done.
        for (key, value) in object {
            object[key] = try normalize(node: value, path: "\(path)/\(key)")
        }

        if object["additionalProperties"] as? Bool == false {
            object["additionalProperties"] = nil
        }

        if let branches = object["anyOf"] as? [Any] {
            let nullBranches = branches.filter(isNullSchema)
            if !nullBranches.isEmpty {
                object = try mergeNullable(object, branches: branches, path: path)
            }
        }
        return object
    }

    private static func isNullSchema(_ branch: Any) -> Bool {
        guard let dict = branch as? [String: Any] else { return false }
        return dict["type"] as? String == "null" && dict.count == 1
    }

    private static func mergeNullable(
        _ object: [String: Any],
        branches: [Any],
        path: String
    ) throws -> [String: Any] {
        let others = branches.filter { !isNullSchema($0) }
        guard others.count == 1, branches.count - others.count == 1,
            let inner = others[0] as? [String: Any]
        else {
            throw Failure(
                path: path,
                reason: "anyOf with a null branch must be exactly one schema plus null"
            )
        }
        guard let innerType = inner["type"] as? String else {
            // A $ref (or a composition) cannot carry a sibling "null" type.
            throw Failure(
                path: path,
                reason: "nullable anyOf branch has no scalar `type` (is it a $ref or a composition?)"
            )
        }
        var merged = object
        merged["anyOf"] = nil
        // The outer node's own keywords (e.g. `description`) win over the inner's.
        for (key, value) in inner where merged[key] == nil { merged[key] = value }
        merged["type"] = [innerType, "null"]
        return merged
    }

    // MARK: - Verify

    /// After the rewrite no composition may still list a bare null schema.
    private static func assertNoNullBranchRemains(_ node: Any, path: String) throws {
        if let array = node as? [Any] {
            for (index, value) in array.enumerated() {
                try assertNoNullBranchRemains(value, path: "\(path)/\(index)")
            }
        } else if let object = node as? [String: Any] {
            for keyword in ["anyOf", "oneOf", "allOf"] {
                if let branches = object[keyword] as? [Any], branches.contains(where: isNullSchema) {
                    throw Failure(path: "\(path)/\(keyword)", reason: "a null branch survived normalisation")
                }
            }
            for (key, value) in object {
                try assertNoNullBranchRemains(value, path: "\(path)/\(key)")
            }
        }
    }
}
