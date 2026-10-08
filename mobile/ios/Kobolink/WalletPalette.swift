import SwiftUI
import UIKit

/// Green is a payment state and this is its only use in the wallet: a payment that went through, with an icon and
/// words beside it. The brand accent is blue, so the accent never competes with a payment state. The asset is the
/// same colour set the checkout's result screens use (light, dark and increased-contrast variants, 5.9:1 or better
/// on the lightest and darkest backgrounds).
extension Color {
    static let paymentSuccess = Color("SuccessText")

    /// Secondary text on the wallet's rows and forms. The system `secondaryLabel` is about 3.4:1 on a white row in
    /// light mode, under the 4.5:1 text needs, so this is the semantic `label` at a fixed opacity: still adaptive
    /// (black on light, white on dark, and it follows Increase Contrast). `WalletTextContrastTests` resolves it
    /// against the system backgrounds in both appearances and fails below 4.5:1.
    static let secondaryText = Color(uiColor: .walletSecondaryLabel)
}

extension UIColor {
    /// The label colour at 65%: 6.1:1 or better on every system background, light and dark, base and elevated, normal
    /// and increased contrast (the test prints the lowest it found).
    static let walletSecondaryLabel = UIColor.label.withAlphaComponent(0.65)
}
