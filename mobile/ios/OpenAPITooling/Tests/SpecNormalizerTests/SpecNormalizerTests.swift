import Foundation
import Testing

@testable import SpecNormalizer

@Suite("OpenAPI spec normalisation")
struct SpecNormalizerTests {
    private func normalized(_ json: String) throws -> [String: Any] {
        let output = try SpecNormalizer.normalize(Data(json.utf8))
        return try #require(JSONSerialization.jsonObject(with: output) as? [String: Any])
    }

    private func property(_ schema: [String: Any], _ name: String) throws -> [String: Any] {
        let properties = try #require(schema["properties"] as? [String: Any])
        return try #require(properties[name] as? [String: Any])
    }

    @Test("anyOf [string, null] becomes a nullable string and keeps its constraints")
    func nullableString() throws {
        let result = try normalized(
            """
            {"type":"object","properties":{"description":{"anyOf":[{"type":"string","maxLength":500},{"type":"null"}]}}}
            """
        )
        let description = try property(result, "description")
        #expect(description["type"] as? [String] == ["string", "null"])
        #expect(description["maxLength"] as? Int == 500)
        #expect(description["anyOf"] == nil)
    }

    @Test("the order of the branches does not matter")
    func nullFirst() throws {
        let result = try normalized(
            """
            {"properties":{"x":{"anyOf":[{"type":"null"},{"type":"string"}]}}}
            """
        )
        #expect(try property(result, "x")["type"] as? [String] == ["string", "null"])
    }

    @Test("a nullable integer keeps its bounds")
    func nullableInteger() throws {
        let result = try normalized(
            """
            {"properties":{"amountKobo":{"anyOf":[{"type":"integer","minimum":10000,"maximum":1000000000},{"type":"null"}]}}}
            """
        )
        let amount = try property(result, "amountKobo")
        #expect(amount["type"] as? [String] == ["integer", "null"])
        #expect(amount["minimum"] as? Int == 10_000)
        #expect(amount["maximum"] as? Int == 1_000_000_000)
    }

    @Test("a description on the outer node wins over the branch's")
    func outerKeywordWins() throws {
        let result = try normalized(
            """
            {"properties":{"x":{"description":"outer","anyOf":[{"type":"string","description":"inner"},{"type":"null"}]}}}
            """
        )
        #expect(try property(result, "x")["description"] as? String == "outer")
    }

    @Test("additionalProperties: false is dropped so added fields are ignored")
    func strictObjectsRelaxed() throws {
        let result = try normalized(
            """
            {"type":"object","additionalProperties":false,"properties":{"a":{"type":"object","additionalProperties":false}}}
            """
        )
        #expect(result["additionalProperties"] == nil)
        #expect(try property(result, "a")["additionalProperties"] == nil)
    }

    @Test("additionalProperties with a schema, and a property literally named that, are untouched")
    func otherAdditionalPropertiesKept() throws {
        let result = try normalized(
            """
            {"properties":{"additionalProperties":{"type":"string"},"fields":{"type":"object","additionalProperties":{"type":"array"}}}}
            """
        )
        #expect(try property(result, "additionalProperties")["type"] as? String == "string")
        #expect(try property(result, "fields")["additionalProperties"] != nil)
    }

    @Test("a null branch that carries a description is still a null branch")
    func annotatedNullBranch() throws {
        let result = try normalized(
            """
            {"properties":{"x":{"anyOf":[{"type":"string","maxLength":9},{"type":"null","description":"Absent when open-amount."}]}}}
            """
        )
        let x = try property(result, "x")
        #expect(x["type"] as? [String] == ["string", "null"])
        #expect(x["maxLength"] as? Int == 9)
        #expect(x["anyOf"] == nil)
    }

    @Test("an annotated null branch that cannot be rewritten fails instead of surviving")
    func annotatedNullBranchUnrewritable() {
        let ref = "{\"x\":{\"anyOf\":[{\"$ref\":\"#/a\"},{\"type\":\"null\",\"title\":\"none\"}]}}"
        #expect(throws: SpecNormalizer.Failure.self) { try SpecNormalizer.normalize(Data(ref.utf8)) }
        let oneOf = "{\"x\":{\"oneOf\":[{\"type\":\"string\"},{\"type\":\"null\",\"description\":\"d\"}]}}"
        #expect(throws: SpecNormalizer.Failure.self) { try SpecNormalizer.normalize(Data(oneOf.utf8)) }
    }

    @Test("a type list that already includes null passes through")
    func typeListUntouched() throws {
        let result = try normalized("{\"properties\":{\"c\":{\"type\":[\"string\",\"null\"]}}}")
        #expect(try property(result, "c")["type"] as? [String] == ["string", "null"])
    }

    @Test("an anyOf with no null branch is left alone")
    func plainAnyOf() throws {
        let result = try normalized("{\"properties\":{\"x\":{\"anyOf\":[{\"type\":\"string\"},{\"type\":\"integer\"}]}}}")
        #expect(try property(result, "x")["anyOf"] != nil)
    }

    @Test("a nullable $ref cannot be rewritten, and fails the build instead of dropping the field")
    func nullableRefFails() {
        let json = "{\"properties\":{\"user\":{\"anyOf\":[{\"$ref\":\"#/components/schemas/User\"},{\"type\":\"null\"}]}}}"
        #expect(throws: SpecNormalizer.Failure.self) { try SpecNormalizer.normalize(Data(json.utf8)) }
    }

    @Test("a null branch among several others fails too")
    func nullAmongMany() {
        let json = "{\"x\":{\"anyOf\":[{\"type\":\"string\"},{\"type\":\"integer\"},{\"type\":\"null\"}]}}"
        #expect(throws: SpecNormalizer.Failure.self) { try SpecNormalizer.normalize(Data(json.utf8)) }
    }

    @Test("a null branch in oneOf fails too")
    func nullInOneOf() {
        let json = "{\"x\":{\"oneOf\":[{\"type\":\"string\"},{\"type\":\"null\"}]}}"
        #expect(throws: SpecNormalizer.Failure.self) { try SpecNormalizer.normalize(Data(json.utf8)) }
    }

    @Test("the failure names where it happened")
    func failurePath() {
        let json = "{\"components\":{\"schemas\":{\"A\":{\"properties\":{\"u\":{\"anyOf\":[{\"$ref\":\"#/x\"},{\"type\":\"null\"}]}}}}}}"
        do {
            _ = try SpecNormalizer.normalize(Data(json.utf8))
            Issue.record("expected a failure")
        } catch let failure as SpecNormalizer.Failure {
            #expect(failure.path == "#/components/schemas/A/properties/u")
        } catch {
            Issue.record("unexpected error \(error)")
        }
    }

    @Test("the output is deterministic")
    func deterministic() throws {
        let json = "{\"b\":{\"anyOf\":[{\"type\":\"string\"},{\"type\":\"null\"}]},\"a\":1}"
        #expect(try SpecNormalizer.normalize(Data(json.utf8)) == SpecNormalizer.normalize(Data(json.utf8)))
    }

    /// The real document. If contracts adds a nullable shape this cannot
    /// rewrite, this fails here and in the app build, with the path.
    @Test("apps/api/openapi.json normalises, and no null branch or strict object survives")
    func realDocument() throws {
        let spec = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
            .appending(path: "KobolinkKit/Sources/KobolinkAPI/openapi.json")
        let output = try SpecNormalizer.normalize(Data(contentsOf: spec))
        let text = try #require(String(data: output, encoding: .utf8))
        #expect(!text.contains("\"type\":\"null\""))
        #expect(!text.contains("\"additionalProperties\":false"))
        #expect(text.contains("\"type\":[\"integer\",\"null\"]"))
        #expect(text.contains("\"type\":[\"string\",\"null\"]"))
    }
}
