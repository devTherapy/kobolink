import KobolinkKit
import SwiftUI

@main
struct KobolinkApp: App {
    private let launch: Result<APIConfiguration, APIConfiguration.Problem>

    init() {
        do {
            launch = .success(try APIConfiguration())
        } catch {
            launch = .failure(error)
        }
    }

    var body: some Scene {
        WindowGroup {
            switch launch {
            case .success(let configuration):
                ConnectionView(
                    host: configuration.host,
                    checker: ConnectionChecker(api: KobolinkAPIClient(configuration: configuration))
                )
            case .failure(let problem):
                MisconfiguredView(problem: problem)
            }
        }
    }
}
