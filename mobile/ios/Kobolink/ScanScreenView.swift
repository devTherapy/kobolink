import KobolinkKit
import SwiftUI

/// Scan to Pay. The camera only hands text to `ScanController`; every state the camera can be in has its own
/// screen, and "Enter Details Instead" is on every one of them.
struct ScanScreenView: View {
    let wallet: WalletController
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    private var scan: ScanController { wallet.scan }

    var body: some View {
        Group {
            switch scan.screen {
            case .scanning:
                CameraStage(scan: scan, enterDetails: wallet.send.enterDetails)
            case .needsPermission:
                StatePage(
                    symbol: "camera.fill", symbolStyle: Color.accentColor,
                    heading: "Scan a code to pay",
                    message: "Kobolink uses the camera only to read a payment QR code. Nothing is recorded or saved.",
                    actions: [
                        .init("Allow Camera", .prominent) { Task { await scan.allowCamera() } },
                        .init("Enter Details Instead", .plain, wallet.send.enterDetails),
                    ])
            case .denied:
                StatePage(
                    symbol: "camera.fill", symbolStyle: Color.warningText,
                    heading: "Camera access is off",
                    message: "Kobolink can't scan a code without the camera. You can turn it on in Settings, or type the details instead.",
                    actions: [
                        .init("Open Settings", .prominent) {
                            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                        },
                        .init("Enter Details Instead", .plain, wallet.send.enterDetails),
                    ])
            case .restricted:
                StatePage(
                    symbol: "lock.fill", symbolStyle: Color.warningText,
                    heading: "The camera is restricted",
                    message:
                        "This iPhone doesn't let Kobolink use the camera, for example because of Screen Time or a device profile. Only whoever manages it can change that. You can type the details instead.",
                    actions: [.init("Enter Details Instead", .prominent, wallet.send.enterDetails)])
            case .noCamera:
                StatePage(
                    symbol: "camera.metering.unknown", symbolStyle: Color.warningText,
                    heading: "No camera to scan with",
                    message: "This device has no camera Kobolink can use. You can type the details instead.",
                    actions: [.init("Enter Details Instead", .prominent, wallet.send.enterDetails)])
            case .rejected(let reason):
                StatePage(
                    symbol: "qrcode", symbolStyle: Color.errorText,
                    heading: "Can't use this code",
                    message: reason.message + " Nothing was sent.",
                    actions: [
                        .init("Scan Again", .prominent, scan.scanAgain),
                        .init("Enter Details Instead", .plain, wallet.send.enterDetails),
                    ])
            }
        }
        .onChange(of: scenePhase) { _, phase in
            // Back from Settings (or from the system prompt): look at the permission again. A rejected code stays
            // on screen until the person asks to scan again.
            if phase == .active, scan.screen != .scanning {
                if case .rejected = scan.screen { return }
                scan.prepare()
            }
        }
    }
}

/// The live camera, a frame to aim with, and the way out.
private struct CameraStage: View {
    let scan: ScanController
    let enterDetails: () -> Void

    var body: some View {
        ZStack {
            QRScannerView { scan.didRead($0) }
                .ignoresSafeArea(edges: .bottom)

            RoundedRectangle(cornerRadius: 24)
                .strokeBorder(.white, lineWidth: 4)
                .aspectRatio(1, contentMode: .fit)
                .padding(56)
                .shadow(color: .black.opacity(0.4), radius: 4)
                .accessibilityHidden(true)

            VStack(spacing: 12) {
                Spacer()
                Text("Point the camera at a Kobolink payment QR code.")
                    .font(.callout)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                Button(action: enterDetails) {
                    Text("Enter Details Instead").fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .foregroundStyle(Color(.systemBackground))
            }
            .padding()
        }
        .background(Color.black)
    }
}

/// One of the camera's other states: a symbol, what is going on, and what can be done.
private struct StatePage: View {
    struct Action: Identifiable {
        enum Kind { case prominent, plain }
        let title: String
        let kind: Kind
        let run: () -> Void
        var id: String { title }

        init(_ title: String, _ kind: Kind, _ run: @escaping () -> Void) {
            self.title = title
            self.kind = kind
            self.run = run
        }
    }

    let symbol: String
    let symbolStyle: Color
    let heading: String
    let message: String
    let actions: [Action]

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Image(systemName: symbol)
                    .font(.largeTitle)
                    .imageScale(.large)
                    .foregroundStyle(symbolStyle)
                    .accessibilityHidden(true)
                Text(heading)
                    .font(.title2.bold())
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                Text(message)
                    .font(.body)
                    .multilineTextAlignment(.center)
                VStack(spacing: 8) {
                    ForEach(actions) { action in
                        switch action.kind {
                        case .prominent:
                            Button(action: action.run) {
                                Text(action.title).fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: 44)
                            }
                            .buttonStyle(.borderedProminent)
                            .foregroundStyle(Color(.systemBackground))
                        case .plain:
                            Button(action: action.run) {
                                Text(action.title).frame(maxWidth: .infinity, minHeight: 44)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
                .controlSize(.large)
                .padding(.top, 4)
            }
            .padding()
            .frame(maxWidth: .infinity)
        }
        .background(Color(.systemGroupedBackground))
    }
}
