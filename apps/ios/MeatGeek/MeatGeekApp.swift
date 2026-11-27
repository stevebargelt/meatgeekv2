import MeatGeekActivity
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
    /// The cook a tapped lock-screen activity opens (`meatgeek://cook/<id>`),
    /// until the signed-in screens show it.
    @State private var openCook: String?

    var body: some Scene {
        WindowGroup {
            RootView(
                root: root, session: app.session, now: app.now, live: app.live,
                notifications: app.notifications,
                activities: app.activities, activityLive: app.activityLive, openCook: $openCook
            )
                // A tapped lock-screen activity's link opens its cook.
                // Otherwise MSAL's own URLs, if any. Sign-in uses the system
                // browser (ASWebAuthenticationSession), which hands MSAL its
                // redirect itself, and never the Authenticator broker
                // (HAR-171), so that is not expected to be called.
                .onOpenURL { url in
                    if let cookID = CookLink.cookID(from: url) {
                        openCook = cookID
                    } else {
                        _ = MSALTokenProvider.handle(url: url)
                    }
                }
                .task { await app.session.restore() }
        }
    }
}

/// The session, the clock, the live services, alerts and the lock-screen
/// activities the app runs on.
struct AppServices {
    let session: SessionModel
    let now: @Sendable () -> Date
    let live: LiveServices
    let notifications: NotificationsModel
    let activities: any LiveActivities
    /// What the activities follow readings with; nil in UI test mode.
    let activityLive: LiveServices?
}

/// Builds the app's session from its Info.plist config, with the real clock
/// the SignalR hub, the system's notifications and ActivityKit, or everything
/// from the fakes in UI test mode
/// (`MEATGEEK_UI_TEST=1`, see `UITestMode`).
enum AppComposition {
    @MainActor
    static func make(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        bundle: Bundle = .main
    ) -> AppServices {
        if UITestMode.isEnabled(environment) {
            let app = UITestMode.makeApp(environment: environment)
            return AppServices(
                session: app.session, now: app.now, live: app.live, notifications: app.notifications,
                activities: app.activities, activityLive: nil
            )
        }
        let session = makeSession(bundle: bundle)
        let live = LiveServices(createHub: SignalRLiveHub.factory)
        return AppServices(
            session: session,
            now: { Date() },
            live: live,
            notifications: NotificationsModel(port: SystemNotifications.shared, session: session, defaults: .standard),
            activities: ActivityKitLiveActivities(),
            activityLive: live
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
