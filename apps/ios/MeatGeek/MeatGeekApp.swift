import MeatGeekKit
import MeatGeekMSAL
import SwiftUI

@main
struct MeatGeekApp: App {
    @State private var root = RootModel(
        appVersion: AppVersion(infoDictionary: Bundle.main.infoDictionary)
    )
    @State private var session = AppComposition.makeSession()

    var body: some Scene {
        WindowGroup {
            RootView(root: root, session: session, now: UITestMode.now(environment: ProcessInfo.processInfo.environment))
                // A redirect back from Microsoft Authenticator. With the
                // system browser (ASWebAuthenticationSession) MSAL gets the
                // redirect itself and this is not called.
                .onOpenURL { url in MSALTokenProvider.handle(url: url) }
                .task { await session.restore() }
        }
    }
}

/// Builds the app's session from its Info.plist config, or from the fakes in
/// UI test mode (`MEATGEEK_UI_TEST=1`, see `UITestMode`).
enum AppComposition {
    @MainActor
    static func makeSession(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        bundle: Bundle = .main
    ) -> SessionModel {
        if UITestMode.isEnabled(environment) {
            return UITestMode.makeSession(environment: environment)
        }
        switch AppConfig.parse(infoDictionary: bundle.infoDictionary) {
        case .invalid(let problems):
            return .unavailable(
                "The app's configuration is invalid:\n" + problems.map { "• \($0)" }.joined(separator: "\n")
            )
        case .notConfigured:
            return .notConfigured()
        case .ready(let config):
            do {
                let provider = try MSALTokenProvider(
                    config: config,
                    bundleIdentifier: bundle.bundleIdentifier ?? "com.meatgeek.ios"
                )
                return SessionModel(
                    tokenProvider: provider,
                    api: APIClientFactory.makeClient(baseURL: config.apiBaseURL, tokenProvider: provider)
                )
            } catch {
                return .unavailable("Sign-in could not start: \(error.localizedDescription)")
            }
        }
    }
}
