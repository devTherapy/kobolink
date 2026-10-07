package com.folusayo.kobolink.api

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Kotlin models are generated from a normalised copy of
 * `apps/api/openapi.json` (see `normalizeOpenApi` in app/build.gradle.kts),
 * because the generator mishandles OpenAPI 3.1 constructs. If contracts starts
 * emitting a 3.1 construct the normaliser does not rewrite, the generator would
 * silently mis-generate it again; this fails first and names the construct.
 *
 * Runs against the file the build produced (the unit-test task depends on
 * compilation, which depends on generation, which depends on normalisation).
 */
class SpecNormalizationTest {

    private fun load(path: String): JsonElement {
        // Gradle runs JVM tests with the module (`app/`) as the working directory.
        val file = File(path)
        check(file.exists()) { "expected ${file.absolutePath} to exist" }
        return Json.parseToJsonElement(file.readText())
    }

    /** Every place a 3.1-only construct appears, as "path: what". */
    private fun violations(node: JsonElement, path: String = "$"): List<String> = when (node) {
        is JsonObject -> buildList {
            val anyOf = node["anyOf"]
            if (anyOf is JsonArray && anyOf.any { (it as? JsonObject)?.get("type")?.let { t -> (t as? JsonPrimitive)?.content == "null" } == true }) {
                add("$path: anyOf containing {type: null}")
            }
            if ("const" in node && node["const"] !is JsonObject) add("$path: const")
            if (node["type"] is JsonArray) add("$path: type as an array")
            if ("propertyNames" in node && node["propertyNames"] is JsonObject) add("$path: propertyNames")
            for (key in listOf("exclusiveMinimum", "exclusiveMaximum")) {
                val bound = node[key]
                if (bound is JsonPrimitive && !bound.isString && bound.content != "true" && bound.content != "false") {
                    add("$path: numeric $key")
                }
            }
            node.forEach { (key, child) -> addAll(violations(child, "$path/$key")) }
        }
        is JsonArray -> node.flatMapIndexed { i, child -> violations(child, "$path/$i") }
        else -> emptyList()
    }

    @Test
    fun `the detector finds the constructs in the raw 3-1 document`() {
        // Proves the walker above can fail: the raw document has all of these.
        val found = violations(load("../../../apps/api/openapi.json")).map { it.substringAfter(": ") }.toSet()
        assertTrue(found.toString(), "anyOf containing {type: null}" in found)
        assertTrue(found.toString(), "const" in found)
        assertTrue(found.toString(), "type as an array" in found)
        assertTrue(found.toString(), "propertyNames" in found)
    }

    @Test
    fun `no 3-1-only construct survives normalisation`() {
        val left = violations(load("build/openapi/openapi.normalized.json"))
        assertEquals("3.1-only constructs the generator mishandles: $left", emptyList<String>(), left)
    }

    @Test
    fun `the normalised copy is declared as 3-0 and keeps every path`() {
        val raw = load("../../../apps/api/openapi.json") as JsonObject
        val normalised = load("build/openapi/openapi.normalized.json") as JsonObject
        assertEquals("3.0.3", (normalised["openapi"] as JsonPrimitive).content)
        assertEquals((raw["paths"] as JsonObject).keys, (normalised["paths"] as JsonObject).keys)
    }
}
