import Foundation

/// The app's sign-in and API settings, read from its Info.plist.
///
/// The values come from `apps/ios/Config/Dev.xcconfig` through the Info.plist
/// keys in `Config/MeatGeek-Info.plist`. None of them is a secret: they are a
/// public client id, a tenant id, a scope and a URL, the same values as
/// `apps/web/public/config.json`. Mirrors `apps/web/src/config/config.ts`.
public struct AppConfig: Sendable, Equatable {
    /// Base URL of the API, including the `/api` prefix, without a trailing slash.
    public let apiBaseURL: URL
    /// Entra tenant id; the authority is login.microsoftonline.com/<tenantID>.
    public let tenantID: String
    /// The iOS public-client registration's client id. Empty until that
    /// registration exists ("not configured").
    public let clientID: String
    /// The API's delegated scope, e.g. api://<api-app-id>/access_as_user.
    public let apiScope: String

    public init(apiBaseURL: URL, tenantID: String, clientID: String, apiScope: String) {
        self.apiBaseURL = apiBaseURL
        self.tenantID = tenantID
        self.clientID = clientID
        self.apiScope = apiScope
    }

    /// `https://login.microsoftonline.com/<tenantID>`.
    public var authorityURL: URL {
        URL(string: "https://login.microsoftonline.com")!.appending(path: tenantID)
    }

    /// The Info.plist keys the config is read from, and the xcconfig build
    /// settings that fill them.
    public enum Key: String, CaseIterable, Sendable {
        case apiBaseURL = "MeatGeekAPIBaseURL"
        case tenantID = "MeatGeekTenantID"
        case clientID = "MeatGeekClientID"
        case apiScope = "MeatGeekAPIScope"

        /// The build setting in `Config/Dev.xcconfig` that fills this key.
        public var buildSetting: String {
            switch self {
            case .apiBaseURL: "MEATGEEK_API_BASE_URL"
            case .tenantID: "MEATGEEK_TENANT_ID"
            case .clientID: "MEATGEEK_CLIENT_ID"
            case .apiScope: "MEATGEEK_API_SCOPE"
            }
        }

        var label: String { "\(buildSetting) (Info.plist \(rawValue))" }
    }
}

/// The outcome of reading the config.
public enum ConfigResult: Sendable, Equatable {
    /// Every value is present: sign-in can start.
    case ready(AppConfig)
    /// Valid, but the client id is empty: the iOS app registration does not
    /// exist yet, so nobody can sign in.
    case notConfigured(AppConfig)
    /// Something is missing or malformed; every problem found, in key order.
    case invalid([String])
}

extension AppConfig {
    /// Checks the config in an Info.plist dictionary (`Bundle.main.infoDictionary`)
    /// and lists every problem found.
    public static func parse(infoDictionary: [String: Any]?) -> ConfigResult {
        let info = infoDictionary ?? [:]
        var problems: [String] = []

        func requiredString(_ key: Key) -> String? {
            guard let value = (info[key.rawValue] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !value.isEmpty
            else {
                problems.append("\(key.label) is missing or empty.")
                return nil
            }
            return value
        }

        let baseURLString = requiredString(.apiBaseURL)
        let tenantID = requiredString(.tenantID)
        let clientID = (info[Key.clientID.rawValue] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if clientID == nil {
            problems.append("\(Key.clientID.label) is missing or not a string.")
        }
        let apiScope = requiredString(.apiScope)

        var baseURL: URL?
        if let baseURLString {
            baseURL = httpURL(baseURLString)
            if baseURL == nil {
                // An unescaped `//` in an xcconfig starts a comment, which
                // leaves "https:" here.
                problems.append(
                    "\(Key.apiBaseURL.label) is not an http(s) URL with a host: \(baseURLString)"
                        + " (in an xcconfig, write https:/$()/host so // is not read as a comment)"
                )
            }
        }

        guard problems.isEmpty, let baseURL, let tenantID, let clientID, let apiScope else {
            return .invalid(problems)
        }
        let config = AppConfig(apiBaseURL: baseURL, tenantID: tenantID, clientID: clientID, apiScope: apiScope)
        return clientID.isEmpty ? .notConfigured(config) : .ready(config)
    }

    /// The URL with trailing slashes removed, if it is http(s) with a host.
    private static func httpURL(_ string: String) -> URL? {
        var trimmed = Substring(string)
        while trimmed.hasSuffix("/") { trimmed = trimmed.dropLast() }
        guard let components = URLComponents(string: String(trimmed)),
              let scheme = components.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = components.host, !host.isEmpty
        else { return nil }
        return components.url
    }
}
