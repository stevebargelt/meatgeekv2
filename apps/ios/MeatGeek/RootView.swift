import MeatGeekKit
import SwiftUI

/// The placeholder root screen: the app name and the version it is running.
struct RootView: View {
    let model: RootModel

    var body: some View {
        VStack(spacing: 8) {
            Text(model.title)
                .font(.largeTitle.bold())
                .accessibilityIdentifier(AccessibilityID.title)
            Text(model.versionText)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier(AccessibilityID.version)
        }
        .padding()
    }

    /// Identifiers the UI tests find elements by.
    enum AccessibilityID {
        static let title = "root.title"
        static let version = "root.version"
    }
}

#Preview {
    RootView(model: RootModel(appVersion: AppVersion(marketingVersion: "0.1.0", buildNumber: "1")))
}
