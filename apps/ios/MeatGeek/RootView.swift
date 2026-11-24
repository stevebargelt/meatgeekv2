import MeatGeekKit
import SwiftUI

/// The root screen: one of the sign-in states, or the signed-in home.
struct RootView: View {
    let root: RootModel
    let session: SessionModel

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
            HomeView(session: session)
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
    static let homeDisplayName = "home.displayName"
    static let signOut = "home.signOut"
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
