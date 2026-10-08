@preconcurrency import AVFoundation
import SwiftUI

/// The camera, reading QR codes and nothing else. It hands the TEXT of what it reads to `onRead` and decides
/// nothing: what the text means is `QrPayloadDecoder`'s, in the package, where it is tested.
///
/// The session runs only while the view is on screen, on its own queue (starting it blocks), and the preview
/// follows the interface orientation. Nothing is recorded: there is no photo or movie output, only a metadata
/// output for QR codes.
struct QRScannerView: UIViewControllerRepresentable {
    let onRead: (String) -> Void
    /// The camera could not be started or stopped working: the screen shows a state instead of a black rectangle.
    let onFailure: () -> Void

    func makeUIViewController(context: Context) -> ScannerViewController {
        ScannerViewController(onRead: onRead, onFailure: onFailure)
    }

    func updateUIViewController(_ controller: ScannerViewController, context: Context) {
        controller.onRead = onRead
        controller.onFailure = onFailure
    }
}

final class ScannerViewController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    var onRead: (String) -> Void
    var onFailure: () -> Void

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "com.folusayo.kobolink.scanner")
    private let previewLayer = AVCaptureVideoPreviewLayer()
    private var isConfigured = false
    private var didFail = false
    private var runtimeErrorObserver: (any NSObjectProtocol)?

    init(onRead: @escaping (String) -> Void, onFailure: @escaping () -> Void) {
        self.onRead = onRead
        self.onFailure = onFailure
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        previewLayer.session = session
        previewLayer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(previewLayer)
        view.isAccessibilityElement = true
        view.accessibilityLabel = "Camera. Point it at a Kobolink payment QR code."
        view.accessibilityTraits = .image
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer.frame = view.bounds
        if let connection = previewLayer.connection {
            connection.videoRotationAngle =
                switch view.window?.windowScene?.interfaceOrientation ?? .portrait {
                case .landscapeLeft: 180
                case .landscapeRight: 0
                case .portraitUpsideDown: 270
                default: 90
                }
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        start()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        stop()
    }

    deinit {
        if let runtimeErrorObserver { NotificationCenter.default.removeObserver(runtimeErrorObserver) }
    }

    /// Wire the camera to the session once, then run it. Configuring is quick and happens here, on the main
    /// actor, so the delegate is set where it is called; running blocks, so that goes to the session's queue.
    /// Every way this can fail ends in `fail()`: a black screen with no way forward is not an outcome.
    private func start() {
        guard !didFail else { return }
        if !isConfigured {
            guard configure() else { return fail() }
            isConfigured = true
            // The camera can stop later too (another app takes it, the hardware faults).
            runtimeErrorObserver = NotificationCenter.default.addObserver(
                forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.fail() }
            }
        }
        let session = self.session
        sessionQueue.async { [weak self] in
            if !session.isRunning { session.startRunning() }
            let running = session.isRunning
            if !running { DispatchQueue.main.async { self?.fail() } }
        }
    }

    private func configure() -> Bool {
        guard let device = AVCaptureDevice.default(for: .video),
            let input = try? AVCaptureDeviceInput(device: device),
            session.canAddInput(input)
        else { return false }
        let output = AVCaptureMetadataOutput()
        session.addInput(input)
        guard session.canAddOutput(output) else {
            session.removeInput(input)
            return false
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = output.availableMetadataObjectTypes.contains(.qr) ? [.qr] : []
        return true
    }

    private func fail() {
        guard !didFail else { return }
        didFail = true
        onFailure()
    }

    private func stop() {
        let session = self.session
        sessionQueue.async {
            if session.isRunning { session.stopRunning() }
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        for case let code as AVMetadataMachineReadableCodeObject in metadataObjects {
            if let text = code.stringValue {
                onRead(text)
                return
            }
        }
    }
}
