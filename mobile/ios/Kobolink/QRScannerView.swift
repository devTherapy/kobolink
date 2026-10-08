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

    func makeUIViewController(context: Context) -> ScannerViewController {
        ScannerViewController(onRead: onRead)
    }

    func updateUIViewController(_ controller: ScannerViewController, context: Context) {
        controller.onRead = onRead
    }
}

final class ScannerViewController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    var onRead: (String) -> Void

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "com.folusayo.kobolink.scanner")
    private let previewLayer = AVCaptureVideoPreviewLayer()
    private var isConfigured = false

    init(onRead: @escaping (String) -> Void) {
        self.onRead = onRead
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

    /// Wire the camera to the session once, then run it. Configuring is quick and happens here, on the main
    /// actor, so the delegate is set where it is called; running blocks, so that goes to the session's queue.
    private func start() {
        if !isConfigured {
            isConfigured = true
            guard let device = AVCaptureDevice.default(for: .video),
                let input = try? AVCaptureDeviceInput(device: device),
                session.canAddInput(input)
            else { return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = output.availableMetadataObjectTypes.contains(.qr) ? [.qr] : []
        }
        let session = self.session
        sessionQueue.async {
            if !session.isRunning { session.startRunning() }
        }
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
