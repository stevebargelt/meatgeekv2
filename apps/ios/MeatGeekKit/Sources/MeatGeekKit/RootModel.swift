import Observation

/// State for the app's root screen.
@MainActor
@Observable
public final class RootModel {
    /// The app's name, shown as the screen title.
    public let title: String
    /// The version the app is running.
    public let appVersion: AppVersion

    public init(title: String = "MeatGeek", appVersion: AppVersion) {
        self.title = title
        self.appVersion = appVersion
    }

    /// The version line under the title, e.g. "Version 0.1.0 (1)".
    public var versionText: String { appVersion.displayString }
}
