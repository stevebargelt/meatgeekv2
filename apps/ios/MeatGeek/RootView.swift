import MeatGeekKit
import SwiftUI

/// The root screen: one of the sign-in states, or the signed-in tabs.
struct RootView: View {
    let root: RootModel
    let session: SessionModel
    /// The clock the screens read (`UITestMode.now(environment:)`).
    var now: @Sendable () -> Date = { Date() }

    var body: some View {
        switch session.state {
        case .notConfigured:
            NotConfiguredView(root: root)
        case .signedOut(let message):
            SignedOutView(root: root, session: session, notice: message, error: nil)
        case .failed(let message):
            SignedOutView(root: root, session: session, notice: nil, error: message)
        case .signingIn:
            ProgressView("Signing in…")
                .accessibilityIdentifier(AccessibilityID.signingIn)
        case .signedIn:
            SignedInView(session: session, now: now)
        }
    }
}

/// Identifiers the UI tests find elements by.
enum AccessibilityID {
    static let title = "root.title"
    static let version = "root.version"
    static let signingIn = "root.signingIn"
    static let notConfigured = "notConfigured.title"
    static let signIn = "signedOut.signIn"
    static let signedOutNotice = "signedOut.notice"
    static let signedOutError = "signedOut.error"
    static let accountMenu = "account.menu"
    static let accountName = "account.displayName"
    static let signOut = "account.signOut"
    static let devicesTab = "tab.devices"
    static let claimDevice = "devices.claim"
    static let devicesLoading = "devices.loading"
    static let devicesEmpty = "devices.empty"
    static let devicesError = "devices.error"
    static let devicesNotice = "devices.notice"
    static let devicesCooksProblem = "devices.cooksProblem"
    static func deviceRow(_ id: String) -> String { "device.row.\(id)" }
    static func deviceName(_ id: String) -> String { "device.name.\(id)" }
    static func deviceConnection(_ id: String) -> String { "device.connection.\(id)" }
    static func deviceCooking(_ id: String) -> String { "device.cooking.\(id)" }
    static func deviceRename(_ id: String) -> String { "device.rename.\(id)" }
    static func deviceRelease(_ id: String) -> String { "device.release.\(id)" }
    static let detailRename = "deviceDetail.rename"
    static let detailRelease = "deviceDetail.release"
    static let confirmRelease = "release.confirm"
    static let claimDeviceID = "claim.deviceID"
    static let claimCode = "claim.claimCode"
    static let claimName = "claim.name"
    static let claimLocation = "claim.location"
    static let claimSubmit = "claim.submit"
    static let claimCancel = "claim.cancel"
    static let claimProblem = "claim.problem"
    static let renameName = "rename.name"
    static let renameSave = "rename.save"
    static let renameCancel = "rename.cancel"
    static let renameProblem = "rename.problem"
}

/// The app name and version, at the top of the signed-out screens.
struct AppHeader: View {
    let root: RootModel

    var body: some View {
        VStack(spacing: 8) {
            Text(root.title)
                .font(.largeTitle.bold())
                .accessibilityIdentifier(AccessibilityID.title)
            Text(root.versionText)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier(AccessibilityID.version)
        }
    }
}

#Preview("Not configured") {
    RootView(
        root: RootModel(appVersion: AppVersion(marketingVersion: "0.1.0", buildNumber: "1")),
        session: .notConfigured()
    )
}
