import MeatGeekKit
import UIKit
import UserNotifications

/// The app's `NotificationsPort`: `UNUserNotificationCenter` for the
/// permission and the alerts, `UIApplication` for the APNs device token.
/// Thin on purpose; what to do with each answer is `NotificationsModel`'s.
///
/// It is the notification center's delegate from launch (`AppDelegate`), so
/// an alert that arrives while the app is open still shows its banner and
/// plays its sound, on any screen, and the tap that launched the app is not
/// lost: it is held until the model asks for taps.
@MainActor
final class SystemNotifications: NSObject, NotificationsPort {
    static let shared = SystemNotifications()

    private var tokenHandler: (@MainActor (Data) -> Void)?
    private var tapHandler: (@MainActor (String) -> Void)?
    private var pendingTap: String?

    /// Becomes the notification center's delegate. Called from
    /// `application(_:didFinishLaunchingWithOptions:)`, as Apple requires
    /// for the launching tap to be delivered.
    func install() {
        UNUserNotificationCenter.current().delegate = self
    }

    func permission() async -> NotificationPermission {
        Self.permission(await UNUserNotificationCenter.current().notificationSettings().authorizationStatus)
    }

    func requestPermission() async -> NotificationPermission {
        // Time Sensitive is an entitlement, not an option: alerts the API
        // marks time-sensitive break through Focus once the user allows alerts.
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        return await permission()
    }

    func registerForRemoteNotifications() {
        UIApplication.shared.registerForRemoteNotifications()
    }

    func unregisterForRemoteNotifications() {
        UIApplication.shared.unregisterForRemoteNotifications()
    }

    func onDeviceToken(_ handler: @escaping @MainActor (Data) -> Void) {
        tokenHandler = handler
    }

    func onAlertTapped(_ handler: @escaping @MainActor (String) -> Void) {
        tapHandler = handler
        if let pendingTap {
            self.pendingTap = nil
            handler(pendingTap)
        }
    }

    /// From `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`.
    func received(deviceToken: Data) {
        tokenHandler?(deviceToken)
    }

    private func tapped(cookID: String) {
        if let tapHandler {
            tapHandler(cookID)
        } else {
            pendingTap = cookID
        }
    }

    private static func permission(_ status: UNAuthorizationStatus) -> NotificationPermission {
        switch status {
        case .authorized, .provisional, .ephemeral: .granted
        case .denied: .denied
        case .notDetermined: .notDetermined
        @unknown default: .denied
        }
    }
}

extension SystemNotifications: UNUserNotificationCenterDelegate {
    /// The app is open: show the alert anyway, with its sound, even on the
    /// cook's own screen.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    /// The pitmaster tapped an alert: open its cook.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let cookID = AlertPayload.cookID(in: response.notification.request.content.userInfo)
        else { return }
        await MainActor.run { self.tapped(cookID: cookID) }
    }
}

/// Hands the APNs token to `SystemNotifications`, and makes it the
/// notification center's delegate at launch. In UI test mode it does
/// nothing: the app runs on `StubNotifications`.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        if !UITestMode.isEnabled(ProcessInfo.processInfo.environment) {
            SystemNotifications.shared.install()
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        SystemNotifications.shared.received(deviceToken: deviceToken)
    }

    /// No token (the simulator on CI never gets one): nothing is registered,
    /// and alerts do not reach this phone. The token is not logged either way.
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {}
}
