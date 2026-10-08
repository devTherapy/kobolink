@preconcurrency import AVFoundation
import KobolinkKit

/// The real camera permission, behind the `CameraAccess` seam the scan screen is written against.
///
/// Asking is the person's choice: nothing here prompts until `requestAccess` is called, and the scan screen only
/// calls it from a button that says what the camera is for.
@MainActor
struct SystemCameraAccess: CameraAccess {
    var hasCamera: Bool { AVCaptureDevice.default(for: .video) != nil }

    var authorization: CameraAuthorization {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .notDetermined: .notDetermined
        case .authorized: .authorized
        case .denied: .denied
        case .restricted: .restricted
        @unknown default: .denied
        }
    }

    func requestAccess() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .video)
    }
}
