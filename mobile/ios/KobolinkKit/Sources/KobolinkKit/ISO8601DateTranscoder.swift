import Foundation
import OpenAPIRuntime

/// Dates on the wire are RFC 3339 with an offset, and the contracts allow
/// the fractional seconds to be present or absent (`toISOString()` always
/// writes `.000Z`). The runtime's stock `.iso8601` transcoder rejects the
/// fractional form, so every `createdAt` would fail to decode.
struct TolerantISO8601DateTranscoder: DateTranscoder {
    func decode(_ dateString: String) throws -> Date {
        let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        if let date = try? withFraction.parse(dateString) { return date }
        let withoutFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: false)
        if let date = try? withoutFraction.parse(dateString) { return date }
        throw DecodingError.dataCorrupted(
            .init(codingPath: [], debugDescription: "Expected an RFC 3339 date-time, got '\(dateString)'")
        )
    }

    func encode(_ date: Date) throws -> String {
        Date.ISO8601FormatStyle(includingFractionalSeconds: true).format(date)
    }
}
