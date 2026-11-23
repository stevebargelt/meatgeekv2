import Foundation

/// The app's marketing version and build number, as read from its Info.plist,
/// and the one line the root screen shows for them.
public struct AppVersion: Sendable, Equatable {
    /// `CFBundleShortVersionString`, e.g. "0.1.0". Nil when missing or blank.
    public let marketingVersion: String?
    /// `CFBundleVersion`, e.g. "42". Nil when missing or blank.
    public let buildNumber: String?

    public init(marketingVersion: String?, buildNumber: String?) {
        self.marketingVersion = Self.normalized(marketingVersion)
        self.buildNumber = Self.normalized(buildNumber)
    }

    /// Reads the version from a bundle's info dictionary
    /// (`Bundle.main.infoDictionary`). Non-string values count as missing.
    public init(infoDictionary: [String: Any]?) {
        self.init(
            marketingVersion: infoDictionary?["CFBundleShortVersionString"] as? String,
            buildNumber: infoDictionary?["CFBundleVersion"] as? String
        )
    }

    /// "Version 0.1.0 (42)", "Version 0.1.0" when the build is missing or the
    /// same as the version, "Build 42" when only the build is known, and
    /// "Version unknown" when neither is.
    public var displayString: String {
        switch (marketingVersion, buildNumber) {
        case let (version?, build?) where version != build:
            "Version \(version) (\(build))"
        case let (version?, _):
            "Version \(version)"
        case let (nil, build?):
            "Build \(build)"
        case (nil, nil):
            "Version unknown"
        }
    }

    private static func normalized(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty
        else { return nil }
        return trimmed
    }
}
