import Foundation
import Testing

@testable import KobolinkKit

/// The camera screen, over a camera that is a script: the Simulator has none, and a real one cannot be asked to
/// show a hostile code.
@MainActor
@Suite("Scan: the camera's states and what a scanned string means")
struct ScanControllerTests {
    private let good = #"{"v":1,"toPhone":"+2348031234567","displayName":"Ada Obi","amountKobo":null}"#

    private func make(
        authorization: CameraAuthorization, hasCamera: Bool = true
    ) -> (ScanController, FakeCamera, LockedBox<[ScannedPayee]>) {
        let camera = FakeCamera()
        camera.authorization = authorization
        camera.hasCamera = hasCamera
        let controller = ScanController(camera: camera)
        let found = LockedBox<[ScannedPayee]>([])
        controller.onPayee = { found.set(found.value + [$0]) }
        controller.prepare()
        return (controller, camera, found)
    }

    @Test("every authorization maps to a screen, camera present or not", arguments: [
        (CameraAuthorization.notDetermined, true, ScanScreen.needsPermission),
        (.notDetermined, false, .noCamera),
        (.authorized, true, .scanning),
        (.authorized, false, .noCamera),
        (.denied, true, .denied),
        (.denied, false, .denied),
        (.restricted, true, .restricted),
        (.restricted, false, .restricted),
    ])
    func states(_ authorization: CameraAuthorization, _ hasCamera: Bool, _ expected: ScanScreen) {
        #expect(make(authorization: authorization, hasCamera: hasCamera).0.screen == expected)
    }

    @Test("never asked: Allow Camera shows the system prompt, and scanning starts if the person says yes")
    func allow() async {
        let (controller, camera, _) = make(authorization: .notDetermined)
        #expect(camera.requests == 0, "nothing is asked until the person chooses to")
        await controller.allowCamera()
        #expect(camera.requests == 1)
        #expect(controller.screen == .scanning)
    }

    @Test("never asked, and the person says no: the denied screen, with Settings")
    func allowRefused() async {
        let (controller, camera, _) = make(authorization: .notDetermined)
        camera.grantsAccess = false
        await controller.allowCamera()
        #expect(controller.screen == .denied)
    }

    @Test("Allow Camera does nothing on any other screen: the prompt is never shown twice")
    func promptOnce() async {
        for authorization in [CameraAuthorization.denied, .restricted, .authorized] {
            let (controller, camera, _) = make(authorization: authorization)
            await controller.allowCamera()
            #expect(camera.requests == 0)
        }
    }

    @Test("coming back from Settings with the camera allowed starts scanning")
    func backFromSettings() {
        let (controller, camera, _) = make(authorization: .denied)
        camera.authorization = .authorized
        controller.prepare()
        #expect(controller.screen == .scanning)
    }

    @Test("a good code yields its payee once, however many frames repeat it")
    func onePayee() {
        let (controller, _, found) = make(authorization: .authorized)
        for _ in 0..<30 { controller.didRead(good) }
        #expect(found.value == [ScannedPayee(toPhone: "+2348031234567", displayName: "Ada Obi", amountKobo: nil)])
    }

    @Test("a code that is not ours is rejected with its reason, and is not re-read until asked", arguments: [
        ("https://pay.folusayo.com/l/aBcDeFgH", QrRejection.notKobolink),
        (#"{"v":2,"toPhone":"+2348031234567","displayName":"Ada","amountKobo":null}"#, .unsupportedVersion),
        (#"{"v":1,"toPhone":"08031234567","displayName":"Ada","amountKobo":null}"#, .invalid),
    ])
    func rejected(_ text: String, _ reason: QrRejection) {
        let (controller, _, found) = make(authorization: .authorized)
        controller.didRead(text)
        #expect(controller.screen == .rejected(reason))
        controller.didRead(text)
        controller.didRead(#"{"v":1,"toPhone":"+2348031234567","displayName":"Ada Obi","amountKobo":null}"#)
        #expect(found.value.isEmpty, "a rejected screen is not scanning")
        controller.scanAgain()
        #expect(controller.screen == .scanning)
        controller.didRead(good)
        #expect(found.value.count == 1)
    }

    @Test("nothing is read unless the camera is scanning")
    func notScanning() {
        for authorization in [CameraAuthorization.notDetermined, .denied, .restricted] {
            let (controller, _, found) = make(authorization: authorization)
            controller.didRead(good)
            #expect(found.value.isEmpty)
        }
        let (noCamera, _, found) = make(authorization: .authorized, hasCamera: false)
        noCamera.didRead(good)
        #expect(found.value.isEmpty)
    }

    @Test("a hostile name that decodes still reaches the form as a name labelled unverified, beside the number")
    func hostileNameReachesFormLabelled() {
        let rig = WalletRig()
        rig.camera.authorization = .authorized
        rig.wallet.openScan()
        #expect(rig.wallet.scan.screen == .scanning)
        rig.wallet.scan.didRead(#"{"v":1,"toPhone":"+2349012345678","displayName":"Your Bank (verified)","amountKobo":null}"#)
        #expect(rig.send.screen == .form)
        #expect(rig.send.form.phone == "0901 234 5678")
        #expect(rig.send.form.scannedName == "Your Bank (verified)")
        #expect(WalletCopy.qrNameLabel == "Name in the QR code (not verified)")
    }

    @Test("a rejected code does not change the form")
    func rejectedLeavesForm() {
        let rig = WalletRig()
        rig.camera.authorization = .authorized
        rig.wallet.openScan()
        rig.wallet.scan.didRead("not a code")
        #expect(rig.send.screen == .scan)
        #expect(rig.send.form.isEmpty)
    }

    @Test("with a payment unresolved, Scan to Pay opens the payment, not the camera")
    func scanWhileUnresolved() async {
        let rig = WalletRig()
        rig.camera.authorization = .authorized
        rig.service.queueTransfer(.failure(WK.offline))
        rig.startPayment()
        _ = await waitUntil { rig.failure != nil }
        rig.wallet.sheetDidDismiss()
        rig.wallet.openScan()
        guard case .failed = rig.send.screen else { Issue.record("\(rig.send.screen)"); return }
        #expect(rig.wallet.isSendPresented)
    }

    @Test("sign-out resets the camera screen too: nothing scanned survives")
    func signOutResets() {
        let rig = WalletRig()
        rig.camera.authorization = .authorized
        rig.wallet.openScan()
        rig.wallet.scan.didRead("nope")
        #expect(rig.wallet.scan.screen == .rejected(.notKobolink))
        rig.wallet.sessionDidChange(.signedOutByChoice)
        #expect(rig.wallet.scan.screen == .scanning)
    }
}
