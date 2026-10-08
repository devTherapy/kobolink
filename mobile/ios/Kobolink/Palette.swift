import SwiftUI

/// The colours the system does not supply. Everything else in the app is a semantic system colour
/// (`label`, `secondaryLabel`, `systemBackground`, `separator`, the tint).
///
/// Green, amber and red belong to payment states, so the brand accent is none of them, and these two are
/// only for text and symbols that say a payment state or an error. They exist because the system red is
/// 3.55:1 on white, under the 4.5:1 text needs, and amber text is unreadable on white. Each has light, dark
/// and increased-contrast variants in the asset catalog; contrast on the lightest and darkest form
/// backgrounds is 5.9:1 and 6.1:1 or better.
extension Color {
    /// Error and refusal text, and the symbol beside it.
    static let errorText = Color("ErrorText")
    /// A state to notice (a link switched off, a price that changed, a payment of unknown outcome).
    static let warningText = Color("WarningText")
}
