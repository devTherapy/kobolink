import SwiftUI

/// Green is a payment state and this is its only use in the wallet: a payment that went through, with an icon and
/// words beside it. The brand accent is blue, so the accent never competes with a payment state. The asset is the
/// same colour set the checkout's result screens use (light, dark and increased-contrast variants, 5.9:1 or better
/// on the lightest and darkest backgrounds).
extension Color {
    static let paymentSuccess = Color("SuccessText")
}
