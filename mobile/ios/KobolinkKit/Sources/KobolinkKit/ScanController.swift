import Foundation
import Observation

/// Where the camera permission stands. Mirrors `AVAuthorizationStatus` without importing AVFoundation, so the
/// package builds and tests on the Mac.
public enum CameraAuthorization: Equatable, Sendable {
    /// Never asked: the system prompt has not been shown.
    case notDetermined
    case authorized
    /// The person said no, or switched it off in Settings. Only Settings can change that.
    case denied
    /// Something other than the person (Screen Time, a device profile) forbids it. Settings cannot change that.
    case restricted
}

/// The camera, behind a seam: the real one is `SystemCameraAccess` in the app target (AVFoundation); tests inject
/// a script, because the Simulator has no camera.
@MainActor
public protocol CameraAccess {
    /// Is there a camera to point at all? The Simulator, and some iPads in some modes, have none.
    var hasCamera: Bool { get }
    var authorization: CameraAuthorization { get }
    /// Show the system prompt. `true` if the person allowed it.
    func requestAccess() async -> Bool
}

/// What the scan screen shows.
public enum ScanScreen: Equatable, Sendable {
    /// Never asked: say what the camera is for BEFORE the system prompt, then ask.
    case needsPermission
    /// Said no. Explain, and offer Settings.
    case denied
    /// Forbidden by Screen Time or a profile: explain; there is no Settings button because it would not help.
    case restricted
    /// There is no camera. "Enter details instead" is the way forward.
    case noCamera
    case scanning
    /// The code was not one this app will pay. Scanning stays off until the person asks again, so a code held in
    /// front of the camera is not re-read in a loop.
    case rejected(QrRejection)
}

/// The camera screen's decisions: which state to show, and what a scanned string means. The camera view only hands
/// it text (`didRead`); the format is `QrPayloadDecoder`'s alone.
@MainActor
@Observable
public final class ScanController {
    public private(set) var screen: ScanScreen = .needsPermission

    @ObservationIgnored private let camera: any CameraAccess
    /// Told once with a payee that decoded. After it, further reads are ignored until `scanAgain`.
    @ObservationIgnored public var onPayee: (@MainActor (ScannedPayee) -> Void)?
    @ObservationIgnored private var finished = false

    public init(camera: any CameraAccess) {
        self.camera = camera
    }

    /// Decide what to show now. Called when the screen appears and when the app returns from Settings.
    public func prepare() {
        finished = false
        screen = Self.screen(for: camera)
    }

    /// "Allow Camera": the system prompt, then whatever it decided.
    public func allowCamera() async {
        guard screen == .needsPermission else { return }
        _ = await camera.requestAccess()
        prepare()
    }

    /// The camera read `text`. Frames repeat the same code many times a second, so only the first counts.
    public func didRead(_ text: String) {
        guard screen == .scanning, !finished else { return }
        switch QrPayloadDecoder.decode(text) {
        case .payee(let payee):
            finished = true
            onPayee?(payee)
        case .rejected(let rejection):
            finished = true
            screen = .rejected(rejection)
        }
    }

    /// "Scan Again" after a rejected code.
    public func scanAgain() {
        guard case .rejected = screen else { return }
        prepare()
    }

    static func screen(for camera: any CameraAccess) -> ScanScreen {
        switch camera.authorization {
        case .restricted:
            return .restricted
        case .denied:
            return .denied
        case .notDetermined:
            // Asking for a camera that is not there would only be confusing.
            return camera.hasCamera ? .needsPermission : .noCamera
        case .authorized:
            return camera.hasCamera ? .scanning : .noCamera
        }
    }
}
