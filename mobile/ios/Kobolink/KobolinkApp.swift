import KobolinkKit
import SwiftUI

@main
struct KobolinkApp: App {
    private let home: RootView.Home

    init() {
        do {
            let configuration = try APIConfiguration()
            home = .connection(
                host: configuration.host,
                checker: ConnectionChecker(api: KobolinkAPIClient(configuration: configuration))
            )
        } catch {
            home = .misconfigured(error)
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView(home: home)
        }
    }
}
