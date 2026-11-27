import MeatGeekKit
import MeatGeekLive
import MeatGeekMSAL
import SwiftUI

@main
struct MeatGeekApp: App {
    /// The APNs token and the notification center's delegate (SystemNotifications.swift).
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var root = RootModel(
        appVersion: AppVersion(infoDictionary: Bundle.main.infoDictionary)
    )
    @State private var app = AppComposition.make()

    var body: some Scene {
        WindowGroup {
            RootView(root: root, session: app.session, now: app.now, live: app.live, notifications: app.notifications)
                // MSAL's own URLs, if any. Sign-in uses the system browser
                // (ASWebAuthenticationSession), which hands MSAL its redirect
                // itself, and never the Authenticator broker (HAR-171), so
                // this is not expected to be called.
                .onOpenURL { url in MSALTokenProvider.handle(url: url) }
                .task { await app.session.restore() }
        }
    }
}

/// The session, the clock, the live services and alerts the app runs on.
struct AppServices {
    let session: SessionModel
    let now: @Sendable () -> Date
    let live: LiveServices
    let notifications: NotificationsModel
}

/// Builds the app's session from its Info.plist config, with the real clock
/// the SignalR hub and the system's notifications, or everything from the
/// fakes in UI test mode
/// (`MEATGEEK_UI_TEST=1`, see `UITestMode`).
enum AppComposition {
    @MainActor
    static func make(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        bundle: Bundle = .main
    ) -> AppServices {
        if UITestMode.isEnabled(environment) {
            let app = UITestMode.makeApp(environment: environment)
            return AppServices(session: app.session, now: app.now, live: app.live, notifications: app.notifications)
        }
        let session = makeSession(bundle: bundle)
        return AppServices(
            session: session,
            now: { Date() },
            live: LiveServices(createHub: SignalRLiveHub.factory),
            notifications: NotificationsModel(port: SystemNotifications.shared, session: session)
        )
    }

    @MainActor
    static func makeSession(bundle: Bundle) -> SessionModel {
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
