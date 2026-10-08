import Testing
import UIKit

@testable import Kobolink

/// The wallet's secondary text is `UIColor.walletSecondaryLabel` (the system `label` colour at a fixed opacity). This resolves it
/// against every background it sits on, in both appearances, both contrast settings and both elevation levels, and
/// computes the WCAG ratio.
@Suite("Wallet: secondary text is at least 4.5:1 in light and dark")
struct WalletTextContrastTests {
    private struct RGB { let r: Double, g: Double, b: Double }

    private func resolve(_ color: UIColor, _ traits: UITraitCollection) -> (rgb: RGB, alpha: Double) {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a)
        return (RGB(r: r, g: g, b: b), a)
    }

    private func luminance(_ c: RGB) -> Double {
        func lin(_ v: Double) -> Double { v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
    }

    private func ratio(text: UIColor, over background: UIColor, _ traits: UITraitCollection) -> Double {
        let bg = resolve(background, traits).rgb
        let (fg, alpha) = resolve(text, traits)
        let blended = RGB(
            r: alpha * fg.r + (1 - alpha) * bg.r, g: alpha * fg.g + (1 - alpha) * bg.g, b: alpha * fg.b + (1 - alpha) * bg.b)
        let a = luminance(blended), b = luminance(bg)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    @Test("over every system background the wallet's rows and forms sit on")
    func atLeastFourPointFive() {
        let text = UIColor.walletSecondaryLabel
        let backgrounds: [(String, UIColor)] = [
            ("systemBackground", .systemBackground),
            ("secondarySystemBackground", .secondarySystemBackground),
            ("systemGroupedBackground", .systemGroupedBackground),
            ("secondarySystemGroupedBackground", .secondarySystemGroupedBackground),
        ]
        var lowest = Double.infinity
        for style in [UIUserInterfaceStyle.light, .dark] {
            for contrast in [UIAccessibilityContrast.normal, .high] {
                for level in [UIUserInterfaceLevel.base, .elevated] {
                    let traits = UITraitCollection(traitsFrom: [
                        UITraitCollection(userInterfaceStyle: style),
                        UITraitCollection(accessibilityContrast: contrast),
                        UITraitCollection(userInterfaceLevel: level),
                    ])
                    for (name, background) in backgrounds {
                        let value = ratio(text: text, over: background, traits)
                        lowest = min(lowest, value)
                        #expect(value >= 4.5, "\(name), \(style.rawValue) \(contrast.rawValue) \(level.rawValue): \(value)")
                    }
                }
            }
        }
        print("WalletTextContrast lowest ratio:", lowest)
    }

    @Test("the system secondaryLabel is why: on a white row in light mode it is under 4.5:1")
    func systemSecondaryLabelIsTheProblem() {
        let traits = UITraitCollection(userInterfaceStyle: .light)
        #expect(ratio(text: .secondaryLabel, over: .secondarySystemGroupedBackground, traits) < 4.5)
    }
}
