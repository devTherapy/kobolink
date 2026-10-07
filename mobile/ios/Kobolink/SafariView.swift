import SafariServices
import SwiftUI

/// A page of the web app in the system's in-app browser, for anything the app does not handle itself.
/// Present it full screen: `SFSafariViewController` brings its own Done button and toolbar.
///
/// `onFinish` runs when the person dismisses it (Done, or the swipe), so the presenter can clear its
/// state; without it, the same URL arriving again would not present, because the item never changed.
struct SafariView: UIViewControllerRepresentable {
    let url: URL
    let onFinish: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onFinish: onFinish)
    }

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let controller = SFSafariViewController(url: url)
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {
        context.coordinator.onFinish = onFinish
    }

    final class Coordinator: NSObject, SFSafariViewControllerDelegate {
        var onFinish: () -> Void

        init(onFinish: @escaping () -> Void) {
            self.onFinish = onFinish
        }

        func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
            onFinish()
        }
    }
}
