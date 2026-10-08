import Foundation

/// Money is ALWAYS an integer number of kobo. Never a float, never naira.
///
/// This is the iOS twin of `packages/contracts/src/money.ts` (`formatNaira`, `parseNaira`,
/// `isValidAmountKobo`, `MIN_AMOUNT_KOBO`, `MAX_AMOUNT_KOBO`) and the ONLY file in the app allowed to
/// divide or multiply by 100. Everything else passes `Int` kobo around untouched and formats at the
/// last step by calling `Kobo.formatNaira`. `MoneyDisciplineTests` fails the build of the test
/// target if a `/ 100`, a `Double` or a `Decimal` appears in any other source file.
///
/// The behaviour is pinned two ways: `KoboTests` repeats every case of contracts' `money.test.ts`,
/// and `Resources/money-oracle.json` holds contracts' own answers for a few hundred more inputs
/// (`Tools/generate-money-cases.mjs`), including the ones where JavaScript's idea of whitespace and
/// digits differs from Swift's.
public enum Kobo {
    public static let perNaira = 100

    /// Largest amount a single payment link may carry: ₦10,000,000.
    public static let maxAmountKobo = 10_000_000 * perNaira
    /// Smallest chargeable amount: ₦100.
    public static let minAmountKobo = 100 * perNaira

    private static let nairaSign = "₦"
    /// `Number.MAX_SAFE_INTEGER`. `parseNaira` in contracts returns `null` past it; so does this.
    private static let maxSafeInteger = 9_007_199_254_740_991

    /// Render kobo as naira for display: `1_850_000` becomes `"₦18,500"`. The kobo part is shown only
    /// when it is non-zero, or when `alwaysShowKobo` insists, exactly as `formatNaira` does.
    public static func formatNaira(_ kobo: Int, alwaysShowKobo: Bool = false) -> String {
        let (whole, remainder) = split(kobo)
        let grouped = grouped(whole)
        let body = (alwaysShowKobo || remainder != 0) ? "\(grouped).\(pad2(remainder))" : grouped
        return "\(kobo < 0 ? "-" : "")\(nairaSign)\(body)"
    }

    /// The amount as VoiceOver should say it: `"18,500 naira"`, `"18,500 naira, 50 kobo"`. The visible
    /// "₦" is read inconsistently, so the visible text is paired with this as its accessibility label.
    public static func spokenNaira(_ kobo: Int) -> String {
        let body = spokenNairaUnsigned(kobo)
        return kobo < 0 ? "minus \(body)" : body
    }

    /// The size of the amount as VoiceOver should say it, with no sign: for a caller that says the direction in
    /// words ("out", "in"). Works from the magnitude, so `Int.min` (which has no positive twin) is safe.
    public static func spokenNairaUnsigned(_ kobo: Int) -> String {
        let (whole, remainder) = split(kobo)
        return remainder == 0 ? "\(grouped(whole)) naira" : "\(grouped(whole)) naira, \(remainder) kobo"
    }

    /// Parse what a payer typed: `"18500"`, `"18,500"`, `"₦18,500"`, `"18500.5"`. Returns `nil` for
    /// anything it cannot read exactly, never a guess.
    ///
    /// Mirrors contracts' `parseNaira` step for step, including JavaScript's own definitions: `trim`
    /// and `\s` use the ECMAScript whitespace set (so a no-break space is removed, and a Swift
    /// `Character.isWhitespace` would be wrong), and `\d` is ASCII only (so Arabic-Indic and
    /// full-width digits are refused, and `Character.isNumber` would be wrong).
    public static func parseNaira(_ input: String) -> Int? {
        // `input.trim()` first, then every ₦, comma and whitespace character is dropped wherever it is.
        var scalars = Array(JavaScriptText.trimmed(input).unicodeScalars)
        scalars.removeAll { $0 == "₦" || $0 == "," || JavaScriptText.isWhitespace($0) }

        // `^-?\d+(\.\d{1,2})?$`
        var index = 0
        let negative = scalars.first == "-"
        if negative { index += 1 }
        let wholeStart = index
        while index < scalars.count, isASCIIDigit(scalars[index]) { index += 1 }
        let wholeDigits = scalars[wholeStart..<index]
        guard !wholeDigits.isEmpty else { return nil }
        var fractionDigits: ArraySlice<Unicode.Scalar> = []
        if index < scalars.count {
            guard scalars[index] == "." else { return nil }
            index += 1
            let fractionStart = index
            while index < scalars.count, isASCIIDigit(scalars[index]) { index += 1 }
            fractionDigits = scalars[fractionStart..<index]
            guard (1...2).contains(fractionDigits.count), index == scalars.count else { return nil }
        }

        guard let whole = Int(String(String.UnicodeScalarView(wholeDigits))) else { return nil }
        let fraction = Int(String(String.UnicodeScalarView(fractionDigits)).padding(toLength: 2, withPad: "0", startingAt: 0)) ?? 0
        let (scaled, overflowed) = whole.multipliedReportingOverflow(by: perNaira)
        guard !overflowed else { return nil }
        let (kobo, overflowedAgain) = scaled.addingReportingOverflow(fraction)
        guard !overflowedAgain, kobo <= maxSafeInteger else { return nil }
        return negative ? -kobo : kobo
    }

    /// Is this a chargeable amount for a payment link? ₦100 to ₦10,000,000, both inclusive.
    public static func isValidAmountKobo(_ kobo: Int) -> Bool {
        kobo >= minAmountKobo && kobo <= maxAmountKobo
    }

    /// An amount as it is typed into the field ("15000.50"): digits and the point only, no sign, no
    /// grouping. The inverse of `parseNaira` for a prefilled field.
    public static func fieldText(_ kobo: Int) -> String {
        let (whole, remainder) = split(kobo)
        return remainder == 0 ? "\(whole)" : "\(whole).\(pad2(remainder))"
    }

    // MARK: - Internals

    /// Whole naira and the kobo remainder of `kobo`'s magnitude. Works on the unsigned magnitude so
    /// `Int.min` cannot trap.
    private static func split(_ kobo: Int) -> (whole: UInt, remainder: Int) {
        let magnitude = kobo.magnitude
        return (magnitude / UInt(perNaira), Int(magnitude % UInt(perNaira)))
    }

    private static func pad2(_ remainder: Int) -> String {
        remainder < 10 ? "0\(remainder)" : "\(remainder)"
    }

    /// `1850000` becomes `"1,850,000"`: groups of three, as `toLocaleString('en-NG')` writes them.
    private static func grouped(_ value: UInt) -> String {
        let digits = Array(String(value))
        var out = ""
        for (offset, digit) in digits.enumerated() {
            if offset > 0, (digits.count - offset) % 3 == 0 { out.append(",") }
            out.append(digit)
        }
        return out
    }

    private static func isASCIIDigit(_ scalar: Unicode.Scalar) -> Bool {
        (0x30...0x39).contains(scalar.value)
    }
}
