import SafariServices
import SwiftUI

/// A web page in the system's in-app browser, for anything the app does not handle itself.
/// Present it full screen: `SFSafariViewController` brings its own Done button and toolbar.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
